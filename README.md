# mvsmf-mcp-bridge

A minimal [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that bridges an AI assistant to a running
[mvsMF](https://github.com/mvslovers/mvsmf) instance — a z/OSMF-compatible
REST API for classic MVS 3.8j systems (e.g. running under
[Hercules](http://www.hercules-390.org/) via
[TK5](https://github.com/mvslovers/mvs-tk5)).

Unlike [`zowe/zowe-mcp`](https://github.com/zowe/zowe-mcp) — which only
supports a mock backend or a `--native` SSH backend via the
[Zowe Remote SSH SDK](https://github.com/zowe/zowex) — this bridge talks
directly to mvsMF's z/OSMF-compatible HTTP REST API. Classic MVS 3.8j has no
SSH daemon, so `zowe-mcp --native` cannot reach it; this project fills that
gap for any Hercules/MVS 3.8j guest running mvsMF.

## What it does

Each MCP tool call is translated 1:1 into one HTTP request against mvsMF,
using HTTP Basic Auth:

| Tool | mvsMF endpoint |
|------|----------------|
| `mvsmfInfo` | `GET /zosmf/info` |
| `listDatasets` | `GET /zosmf/restfiles/ds` |
| `readDataset` | `GET /zosmf/restfiles/ds/{name}` |
| `listMembers` | `GET /zosmf/restfiles/ds/{name}/member` |
| `readMember` | `GET /zosmf/restfiles/ds/{name}({member})` |
| `writeDataset` | `PUT /zosmf/restfiles/ds/{name}` |
| `writeMember` | `PUT /zosmf/restfiles/ds/{name}({member})` |
| `listUssFiles` | `GET /zosmf/restfiles/fs?path=...` |
| `readUssFile` | `GET /zosmf/restfiles/fs/{filepath}` |
| `writeUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` |
| `createUssFile` | `POST /zosmf/restfiles/fs/{filepath}` |
| `deleteUssFile` | `DELETE /zosmf/restfiles/fs/{filepath}` |
| `listJobs` | `GET /zosmf/restjobs/jobs` |
| `getJobStatus` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}` |
| `listJobFiles` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files` |
| `readJobFile` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records` |
| `submitJob` | `PUT /zosmf/restjobs/jobs` (inline JCL) |
| `purgeJob` | `DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}` |
| `issueConsoleCommand` | `PUT /zosmf/restconsoles/consoles/{consoleName}` |
| `getConsoleMessages` | `GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}` |
| `getConsoleDetections` | `GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}` |
| `getHardcopyLog` | `GET /zosmf/restconsoles/v1/log` |

See mvsMF's own
[endpoint reference](https://github.com/mvslovers/mvsmf/blob/main/docs/endpoints/README.md)
for the full semantics of each call.

> **Caution:** `submitJob`, `purgeJob`, `writeDataset`, `writeMember`,
> `writeUssFile`, `createUssFile`, `deleteUssFile`, and `issueConsoleCommand`
> all cause real, sometimes irreversible effects on the target MVS system —
> running batch work, cancelling jobs, overwriting or deleting data, and
> issuing operator commands that can affect the whole shared guest. Treat
> them with the same care as any tool that can run arbitrary code.

## Requirements

- Node.js >= 18 (for built-in `fetch`)
- A reachable mvsMF instance (HTTPD + mvsMF module registered, listening on
  some port) and valid TSO credentials on that system

## Install

```bash
git clone https://github.com/locusf/mvsmf-mcp-bridge.git
cd mvsmf-mcp-bridge
npm install
```

## Configuration

Set these environment variables before starting the server:

| Variable | Required | Description |
|----------|----------|--------------|
| `MVSMF_BASE_URL` | no (default `http://127.0.0.1:8090`) | Base URL of the mvsMF/HTTPD instance |
| `MVSMF_USER` | yes | TSO userid |
| `MVSMF_PASSWORD` | yes | TSO password |

## Running standalone

```bash
MVSMF_BASE_URL=http://127.0.0.1:8090 \
MVSMF_USER=HERC01 \
MVSMF_PASSWORD=CUL8TR \
node index.js
```

The server speaks MCP over stdio and logs a one-line startup banner to
stderr.

## Using with an MCP client

### GitHub Copilot CLI

Add to `.mcp.json` (or `.github/mcp.json`) at your project root, or to
`~/.copilot/mcp-config.json` for all projects:

```json
{
  "mcpServers": {
    "mvsmf": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mvsmf-mcp-bridge/index.js"],
      "env": {
        "MVSMF_BASE_URL": "http://127.0.0.1:8090",
        "MVSMF_USER": "HERC01",
        "MVSMF_PASSWORD": "CUL8TR"
      },
      "tools": ["*"]
    }
  }
}
```

### Other MCP clients (Claude Code, Cursor, VS Code, etc.)

Use the same server block shape — see each client's MCP documentation for
where its config file lives and whether it expects `mcpServers` or
`servers` as the top-level key.

## License

MIT — see [LICENSE](LICENSE).
