# Headless MCP host (fork)

Keeps a Penpot workspace open in headless Chromium, so an MCP client can work on Penpot files
without anyone having a file open in a browser.

The upstream MCP plugin only runs inside an open workspace. This host signs in as a dedicated
agent profile, opens a file in headless Chromium when the MCP server needs one, and closes the
browser again after a period of inactivity. The agent profile's MCP token is the token an MCP
client uses to reach it.

## How it fits together

```
MCP client ──token──▶ penpot-mcp ◀──websocket── MCP plugin ◀── headless Chromium ◀── penpot-mcp-headless
                         │                                        (workspace on penpot-frontend-headless)
                         └──── control API (wake, open file, list/create files) ────▶ penpot-mcp-headless
```

- **penpot-mcp-headless** (this package): control API on port 4404, Chromium on demand.
- **penpot-frontend-headless**: a second instance of the frontend image with
  `PENPOT_PUBLIC_URI` set to its internal address, so the headless browser loads Penpot
  without going through the public hostname.
- **penpot-mcp**: the MCP server with `PENPOT_MCP_HEADLESS_URI` set. Before running a plugin
  task for the agent's token it starts the browser if needed and waits for the plugin to
  connect. It also adds three tools for that token: `list_files`, `open_file` and
  `create_file`.

Sessions using any other token behave exactly as upstream: they need the file open in a
browser, and the file tools return an error.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PENPOT_HEADLESS_EMAIL` | required | Agent profile email |
| `PENPOT_HEADLESS_PASSWORD` | required | Agent profile password |
| `PENPOT_HEADLESS_PENPOT_URI` | `http://penpot-frontend-headless:8080` | Internal frontend the browser loads |
| `PENPOT_HEADLESS_PUBLIC_URI` | unset | The backend's public URI; requests to it are served from the internal frontend |
| `PENPOT_HEADLESS_IDLE_MINUTES` | `15` | Close the browser after this long without MCP activity |
| `PENPOT_HEADLESS_CONNECT_TIMEOUT_S` | `90` | How long to wait for the plugin after opening a file |
| `PENPOT_HEADLESS_DEFAULT_FILE_ID` | unset | File to open when none was opened before |
| `PENPOT_HEADLESS_PORT` | `4404` | Control API port |

On the MCP server, set `PENPOT_MCP_HEADLESS_URI=http://penpot-mcp-headless:4404`.

On startup the host enables MCP on the agent profile and creates an MCP access token for it if
none exists. Read that token (as the agent) with the `get-current-mcp-token` RPC command and
use it as the MCP client's `userToken`. The agent profile only sees teams it is a member of;
add it to a team as an editor to work on that team's files.

The last opened file is stored in `/opt/penpot/headless/data/state.json`; mount a volume there
to keep it across container restarts.

## Control API

Internal network only; it has no authentication.

| Method and path | Body | Effect |
|---|---|---|
| `GET /status` | | Browser state, open file, agent token hash |
| `POST /ensure` | | Start the browser and open the last file |
| `POST /touch` | | Reset the idle timer |
| `POST /open` | `{fileId, pageId?}` | Open a file |
| `POST /close` | | Close the browser |
| `GET /files` | | Teams, projects and files visible to the agent |
| `POST /files` | `{projectId, name}` | Create a file |
| `POST /projects` | `{teamId, name}` | Create a project |

## Build

`docker/images/Dockerfile.mcp-headless`, built from the repository root. CI builds it together
with the MCP server image (`.github/workflows/build-mcp-images-fork.yml`).
