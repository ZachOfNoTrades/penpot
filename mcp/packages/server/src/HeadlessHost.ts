import { createHash } from "node:crypto";
import { createLogger } from "./logger";

/**
 * Status reported by the headless host's control API.
 */
export interface HeadlessStatus {
    browser: boolean;
    mcpStatus: string;
    tokenHash: string | null;
    file: { id: string; name: string; teamId: string; projectId: string } | null;
    idleSecondsRemaining: number | null;
}

/**
 * Client for the headless host (`mcp/packages/headless`), which keeps a Penpot
 * workspace open in headless Chromium under a dedicated agent profile so that
 * the MCP plugin can connect without any user having a file open.
 *
 * The host is associated with exactly one MCP token (the agent profile's).
 * Only MCP sessions presenting that token may wake it or drive its file
 * operations; every other token keeps the upstream browser-only behavior.
 */
export class HeadlessHost {
    private readonly logger = createLogger("HeadlessHost");
    private cachedTokenHash: string | null = null;

    private constructor(private readonly baseUri: string) {}

    /**
     * Creates a client when `PENPOT_MCP_HEADLESS_URI` is set; returns undefined otherwise.
     */
    public static fromEnvironment(): HeadlessHost | undefined {
        const uri = process.env.PENPOT_MCP_HEADLESS_URI;
        return uri ? new HeadlessHost(uri.replace(/\/+$/, "")) : undefined;
    }

    private async request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
        const response = await fetch(this.baseUri + path, {
            method,
            headers: { "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        });
        const payload = (await response.json()) as any;
        if (!response.ok) {
            throw new Error(`headless host ${method} ${path} failed: ${payload?.error ?? response.status}`);
        }
        return payload as T;
    }

    public status(): Promise<HeadlessStatus> {
        return this.request("GET", "/status");
    }

    /**
     * Whether the given MCP token is the one the headless host's agent profile uses.
     */
    public async servesToken(userToken: string | undefined): Promise<boolean> {
        if (!userToken) {
            return false;
        }
        const hash = createHash("sha256").update(userToken).digest("hex");
        if (this.cachedTokenHash === hash) {
            return true;
        }
        try {
            this.cachedTokenHash = (await this.status()).tokenHash;
        } catch (error) {
            this.logger.warn("Headless host unreachable: %s", String(error));
            return false;
        }
        return this.cachedTokenHash === hash;
    }

    public ensure(): Promise<HeadlessStatus> {
        return this.request("POST", "/ensure");
    }

    public touch(): void {
        this.request("POST", "/touch").catch((error) => this.logger.warn("touch failed: %s", String(error)));
    }

    public open(fileId: string, pageId?: string): Promise<HeadlessStatus> {
        return this.request("POST", "/open", { fileId, pageId });
    }

    public listFiles(): Promise<{ teams: any[] }> {
        return this.request("GET", "/files");
    }

    public createFile(projectId: string, name: string): Promise<{ id: string; name: string; projectId: string }> {
        return this.request("POST", "/files", { projectId, name });
    }

    public createProject(teamId: string, name: string): Promise<{ id: string; name: string; teamId: string }> {
        return this.request("POST", "/projects", { teamId, name });
    }
}
