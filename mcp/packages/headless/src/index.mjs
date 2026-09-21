// Headless host for the Penpot MCP plugin.
//
// The MCP plugin only runs inside an open Penpot workspace, so an agent can
// normally act only while a person keeps a file open in their browser. This
// service keeps that workspace open itself: it signs in as a dedicated agent
// profile, drives a headless Chromium on demand, and exposes a small control
// API that the MCP server uses to wake it, switch files, and manage files.
//
// Control API (JSON, internal network only):
//   GET  /healthz              liveness
//   GET  /status               browser/file state and the agent token hash
//   POST /ensure               start the browser (if needed) and open a file
//   POST /touch                reset the idle timer
//   POST /open     {fileId, pageId?}
//   POST /close                shut the browser down
//   GET  /files                teams -> projects -> files visible to the agent
//   POST /files    {projectId, name}
//   POST /projects {teamId, name}

import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, request as playwrightRequest } from "playwright-core";

function intEnv(name, fallback) {
    const value = parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(value) ? value : fallback;
}

const config = {
    penpotUri: (process.env.PENPOT_HEADLESS_PENPOT_URI ?? "http://penpot-frontend-headless:8080").replace(/\/+$/, ""),
    // the backend's public URI; URLs it hands out (e.g. exported assets) are rerouted to penpotUri
    publicUri: (process.env.PENPOT_HEADLESS_PUBLIC_URI ?? "").replace(/\/+$/, "") || null,
    email: process.env.PENPOT_HEADLESS_EMAIL,
    password: process.env.PENPOT_HEADLESS_PASSWORD,
    host: process.env.PENPOT_HEADLESS_HOST ?? "0.0.0.0",
    port: intEnv("PENPOT_HEADLESS_PORT", 4404),
    idleMs: intEnv("PENPOT_HEADLESS_IDLE_MINUTES", 15) * 60_000,
    connectTimeoutMs: intEnv("PENPOT_HEADLESS_CONNECT_TIMEOUT_S", 90) * 1000,
    defaultFileId: process.env.PENPOT_HEADLESS_DEFAULT_FILE_ID || null,
    stateFile: process.env.PENPOT_HEADLESS_STATE_FILE ?? "/opt/penpot/headless/data/state.json",
    chromiumPath: process.env.PENPOT_HEADLESS_CHROMIUM_PATH || undefined,
};

if (!config.email || !config.password) {
    console.error("PENPOT_HEADLESS_EMAIL and PENPOT_HEADLESS_PASSWORD are required");
    process.exit(1);
}

function log(message, extra) {
    const line = { time: new Date().toISOString(), msg: message, ...extra };
    console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------------------
// Penpot RPC session (cookie-based, shared with the browser context)
// ---------------------------------------------------------------------------

let api = null;

async function login() {
    if (api) {
        await api.dispose().catch(() => {});
    }
    api = await playwrightRequest.newContext({ baseURL: config.penpotUri });
    const response = await api.post("/api/rpc/command/login-with-password", {
        headers: { accept: "application/json" },
        data: { email: config.email, password: config.password },
    });
    if (!response.ok()) {
        throw new Error(`login failed: HTTP ${response.status()} ${(await response.text()).slice(0, 200)}`);
    }
    log("signed in", { email: config.email });
}

async function rpc(command, params = {}, retry = true) {
    if (!api) {
        await login();
    }
    const response = await api.post(`/api/rpc/command/${command}`, {
        headers: { accept: "application/json" },
        data: params,
    });
    if ((response.status() === 401 || response.status() === 403) && retry) {
        await login();
        return rpc(command, params, false);
    }
    if (response.status() === 204) {
        return null;
    }
    const text = await response.text();
    if (!response.ok()) {
        throw new Error(`${command} failed: HTTP ${response.status()} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
}

let tokenHash = null;

/**
 * Makes sure the agent profile has MCP enabled and owns an MCP access token,
 * so the frontend starts the bundled MCP plugin when a workspace opens.
 */
async function prepareProfile() {
    const profile = await rpc("get-profile");
    if (!profile?.props?.mcpEnabled) {
        await rpc("update-profile-props", { props: { mcpEnabled: true } });
        log("enabled MCP on the agent profile");
    }
    let token = await rpc("get-current-mcp-token");
    if (!token?.token) {
        token = await rpc("create-access-token", { name: "Headless MCP host", type: "mcp" });
        log("created an MCP access token for the agent profile");
    }
    tokenHash = createHash("sha256").update(token.token).digest("hex");
}

// ---------------------------------------------------------------------------
// Files and projects
// ---------------------------------------------------------------------------

async function listFiles() {
    const [teams, projects] = await Promise.all([rpc("get-teams"), rpc("get-all-projects")]);
    const result = [];
    for (const team of teams) {
        const teamProjects = projects.filter((project) => project.teamId === team.id);
        const entries = [];
        for (const project of teamProjects) {
            const files = await rpc("get-project-files", { projectId: project.id });
            entries.push({
                projectId: project.id,
                projectName: project.name,
                files: files.map((file) => ({ id: file.id, name: file.name, modifiedAt: file.modifiedAt })),
            });
        }
        result.push({ teamId: team.id, teamName: team.name, canEdit: !!team.permissions?.canEdit, projects: entries });
    }
    return result;
}

async function findFile(fileId) {
    for (const team of await listFiles()) {
        for (const project of team.projects) {
            const file = project.files.find((entry) => entry.id === fileId);
            if (file) {
                return { ...file, teamId: team.teamId, projectId: project.projectId };
            }
        }
    }
    return null;
}

async function pickStartFile() {
    const candidates = [state.lastFileId, config.defaultFileId].filter(Boolean);
    for (const id of candidates) {
        const file = await findFile(id);
        if (file) {
            return file;
        }
    }
    const teams = await listFiles();
    const all = teams.flatMap((team) =>
        team.projects.flatMap((project) =>
            project.files.map((file) => ({ ...file, teamId: team.teamId, projectId: project.projectId }))
        )
    );
    all.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    if (all.length > 0) {
        return all[0];
    }
    const profile = await rpc("get-profile");
    const created = await rpc("create-file", { projectId: profile.defaultProjectId, name: "Agent scratch" });
    return { id: created.id, name: created.name, teamId: profile.defaultTeamId, projectId: created.projectId };
}

// ---------------------------------------------------------------------------
// Persistent state (last opened file survives restarts)
// ---------------------------------------------------------------------------

let state = { lastFileId: null };

async function loadState() {
    try {
        state = { ...state, ...JSON.parse(await readFile(config.stateFile, "utf8")) };
    } catch {
        // first run or unreadable state: start fresh
    }
}

async function saveState() {
    try {
        await mkdir(dirname(config.stateFile), { recursive: true });
        await writeFile(config.stateFile, JSON.stringify(state));
    } catch (error) {
        log("could not persist state", { error: String(error) });
    }
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

let browser = null;
let page = null;
let current = null; // { id, name, teamId, projectId, pageId }
let mcpStatus = "disconnected";
let lastActivity = Date.now();
const statusWaiters = new Set();

function touch() {
    lastActivity = Date.now();
}

function setMcpStatus(status) {
    mcpStatus = status;
    for (const waiter of statusWaiters) {
        waiter(status);
    }
}

function waitForMcpConnected(timeoutMs) {
    if (mcpStatus === "connected") {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const done = (value) => {
            clearTimeout(timer);
            statusWaiters.delete(waiter);
            resolve(value);
        };
        const waiter = (status) => status === "connected" && done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        statusWaiters.add(waiter);
    });
}

async function closeBrowser(reason) {
    const closing = browser;
    browser = null;
    page = null;
    setMcpStatus("disconnected");
    if (closing) {
        log("closing browser", { reason });
        await closing.close().catch(() => {});
    }
}

async function launchBrowser() {
    browser = await chromium.launch({
        headless: true,
        executablePath: config.chromiumPath,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const launched = browser;
    launched.on("disconnected", () => {
        if (browser === launched) {
            browser = null;
            page = null;
            setMcpStatus("disconnected");
            log("browser exited");
        }
    });
    const context = await browser.newContext({
        storageState: await api.storageState(),
        viewport: { width: 1600, height: 1000 },
    });
    if (config.publicUri && config.publicUri !== config.penpotUri) {
        await context.route(`${config.publicUri}/**`, rerouteToInternal);
    }
    page = await context.newPage();
    page.on("crash", () => void closeBrowser("page crashed"));
    page.on("console", (message) => {
        const text = message.text();
        // app.main.data.workspace.mcp logs every plugin connection change
        const match = /MCP STATUS.*?:status\s+"?(\w+)"?/.exec(text) || /MCP STATUS.*?(connected|connecting|disconnected|error)/.exec(text);
        if (match) {
            setMcpStatus(match[1]);
            log("mcp plugin status", { status: match[1] });
        }
    });
    log("browser started");
}

/**
 * Serves a request for the public URI from the internal frontend instead. The public
 * hostname is typically behind an auth proxy the headless browser cannot pass. The
 * page origin differs from the public URI, so CORS headers are added to the response.
 */
async function rerouteToInternal(route) {
    const request = route.request();
    const cors = {
        "access-control-allow-origin": config.penpotUri,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
    }
    const url = config.penpotUri + request.url().slice(config.publicUri.length);
    try {
        const response = await route.fetch({ url });
        await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    } catch (error) {
        log("reroute failed", { url, error: String(error?.message ?? error) });
        await route.abort();
    }
}

function workspaceUrl(file, pageId) {
    const params = new URLSearchParams({ "team-id": file.teamId, "file-id": file.id });
    if (pageId) {
        params.set("page-id", pageId);
    }
    return `${config.penpotUri}/#/workspace?${params}`;
}

async function navigate(file, pageId, allowRelogin = true) {
    setMcpStatus("disconnected");
    // leave the current workspace first so the old plugin connection closes
    await page.goto("about:blank");
    await page.goto(workspaceUrl(file, pageId), { waitUntil: "domcontentloaded" });
    const connected = await waitForMcpConnected(config.connectTimeoutMs);
    if (!connected && allowRelogin && /#\/auth/.test(page.url())) {
        log("session expired; signing in again");
        await login();
        await closeBrowser("session renewal");
        await launchBrowser();
        return navigate(file, pageId, false);
    }
    return connected;
}

async function openFile(fileId, pageId) {
    const file = fileId ? await findFile(fileId) : await pickStartFile();
    if (!file) {
        throw new Error(`file ${fileId} is not visible to the agent profile`);
    }
    if (!browser) {
        await launchBrowser();
    }
    const connected = await navigate(file, pageId);
    current = { ...file, pageId: pageId ?? null };
    state.lastFileId = file.id;
    await saveState();
    touch();
    log("opened file", { fileId: file.id, name: file.name, connected });
    return connected;
}

async function ensure() {
    touch();
    if (browser && page && current) {
        return;
    }
    await openFile(current?.id ?? null, current?.pageId ?? null);
}

function status() {
    return {
        browser: !!browser,
        mcpStatus,
        tokenHash,
        file: current ? { id: current.id, name: current.name, teamId: current.teamId, projectId: current.projectId } : null,
        idleSecondsRemaining: browser ? Math.max(0, Math.round((config.idleMs - (Date.now() - lastActivity)) / 1000)) : null,
    };
}

setInterval(() => {
    if (browser && Date.now() - lastActivity > config.idleMs) {
        void closeBrowser("idle");
    }
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

// browser operations are serialized so concurrent tool calls cannot interleave navigations
let queue = Promise.resolve();
function serialized(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
}

const routes = {
    "GET /healthz": async () => ({ ok: true }),
    "GET /status": async () => status(),
    "POST /touch": async () => {
        touch();
        return status();
    },
    "POST /ensure": () =>
        serialized(async () => {
            await ensure();
            return status();
        }),
    "POST /open": (body) =>
        serialized(async () => {
            if (!body.fileId) {
                throw new Error("fileId is required");
            }
            await openFile(body.fileId, body.pageId ?? null);
            return status();
        }),
    "POST /close": () =>
        serialized(async () => {
            await closeBrowser("requested");
            return status();
        }),
    "GET /files": async () => ({ teams: await listFiles() }),
    "POST /files": async (body) => {
        if (!body.projectId || !body.name) {
            throw new Error("projectId and name are required");
        }
        const file = await rpc("create-file", { projectId: body.projectId, name: body.name });
        return { id: file.id, name: file.name, projectId: file.projectId };
    },
    "POST /projects": async (body) => {
        if (!body.teamId || !body.name) {
            throw new Error("teamId and name are required");
        }
        const project = await rpc("create-project", { teamId: body.teamId, name: body.name });
        return { id: project.id, name: project.name, teamId: project.teamId };
    },
};

const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const handler = routes[`${req.method} ${path}`];
    res.setHeader("content-type", "application/json");
    if (!handler) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
    }
    try {
        const body = req.method === "POST" ? await readBody(req) : {};
        res.end(JSON.stringify(await handler(body)));
    } catch (error) {
        log("request failed", { route: `${req.method} ${path}`, error: String(error?.message ?? error) });
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
});

async function main() {
    await loadState();
    // the backend may still be starting; keep retrying the first sign-in
    for (;;) {
        try {
            await login();
            await prepareProfile();
            break;
        } catch (error) {
            log("startup sign-in failed; retrying in 10 s", { error: String(error?.message ?? error) });
            await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
    }
    server.listen(config.port, config.host, () => log("control API listening", { port: config.port }));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        await closeBrowser(signal);
        process.exit(0);
    });
}

await main();
