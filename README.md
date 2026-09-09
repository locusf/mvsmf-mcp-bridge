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

| Tool | mvsMF endpoint | Options |
|------|----------------|---------|
| `mvsmfInfo` | `GET /zosmf/info` | |
| `listDatasets` | `GET /zosmf/restfiles/ds` | `volser`, `start`, `maxItems` |
| `createDataset` | `POST /zosmf/restfiles/ds/{name}` | `like`, `dsorg`, `recfm`, `lrecl`, `blksize`, `primary`, `secondary`, `dirblk`, `alcunit` |
| `deleteDataset` | `DELETE /zosmf/restfiles/ds/{name}` | |
| `readDataset` | `GET /zosmf/restfiles/ds/{name}` | `dataType`, `encoding`, `returnEtag`, `ifNoneMatch` |
| `writeDataset` | `PUT /zosmf/restfiles/ds/{name}` | `content`/`contentBase64`, `dataType`, `encoding`, `ifMatch`, `returnEtag` |
| `listMembers` | `GET /zosmf/restfiles/ds/{name}/member` | `pattern`, `start`, `maxItems` |
| `readMember` | `GET /zosmf/restfiles/ds/{name}({member})` | as `readDataset` |
| `writeMember` | `PUT /zosmf/restfiles/ds/{name}({member})` | as `writeDataset` |
| `deleteMember` | `DELETE /zosmf/restfiles/ds/{name}({member})` | |
| `listUssFiles` | `GET /zosmf/restfiles/fs?path=...` | `maxItems` |
| `readUssFile` | `GET /zosmf/restfiles/fs/{filepath}` | `dataType`, `returnEtag`, `ifNoneMatch` |
| `writeUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` | `content`/`contentBase64`, `dataType`, `ifMatch`, `returnEtag` |
| `createUssFile` | `POST /zosmf/restfiles/fs/{filepath}` | `isDirectory`, `mode` |
| `deleteUssFile` | `DELETE /zosmf/restfiles/fs/{filepath}` | `recursive` |
| `listJobs` | `GET /zosmf/restjobs/jobs` | `owner`, `prefix`, `jobid`, `status`, `maxJobs`, `execData` |
| `getJobStatus` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}` | `execData` |
| `listJobFiles` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files` | |
| `readJobFile` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records` | |
| `submitJob` | `PUT /zosmf/restjobs/jobs` (inline JCL, `text/plain`) | |
| `submitJobFromDataset` | `PUT /zosmf/restjobs/jobs` (`{"file": "'DSN(MEM)'"}`) | |
| `purgeJob` | `DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}` | |
| `issueConsoleCommand` | `PUT /zosmf/restconsoles/consoles/{consoleName}` | `async`, `solKey`, `unsolKey`, `unsolDetectSync`, `unsolDetectTimeout`, `detectTime` |
| `getConsoleMessages` | `GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}` | |
| `getConsoleDetections` | `GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}` | |
| `getHardcopyLog` | `GET /zosmf/restconsoles/v1/log` | `timeRange`, `time`, `timestamp`, `direction`, `hardcopy`, `sysName` |

See mvsMF's own
[endpoint reference](https://github.com/mvslovers/mvsmf/blob/main/docs/endpoints/README.md)
for the full semantics of each call. Not bridged: `/zosmf/services/authenticate`
(the bridge sends Basic credentials on every call, and mvsMF accepts that) and
the `request: rename` control body.

> **Caution:** `submitJob`, `submitJobFromDataset`, `purgeJob`,
> `createDataset`, `deleteDataset`, `writeDataset`, `writeMember`,
> `deleteMember`, `writeUssFile`, `createUssFile`, `deleteUssFile`, and
> `issueConsoleCommand` all cause real, sometimes irreversible effects on the
> target MVS system — running batch work, cancelling jobs, allocating,
> overwriting or deleting data, and issuing operator commands that can affect
> the whole shared guest (mvsMF applies **no** per-command authorization on
> the console endpoint). Treat them with the same care as any tool that can
> run arbitrary code.

### Transfer modes and code pages

Data set and USS reads/writes default to mvsMF's **text** mode: the server
converts between ASCII and EBCDIC and splits records at newlines. Two other
modes are exposed through `dataType`:

- `binary` — bytes as stored. Reads return `bodyBase64`; writes take
  `contentBase64`. Binary writes are split at LRECL boundaries.
- `record` (reads only) — binary with a 4-byte big-endian length before each
  record. mvsMF does not implement it for writes and the bridge refuses it.

mvsMF's text translation uses one fixed table, and a few characters sit on
different EBCDIC code points in IBM-037 and IBM-1047 — `[` `]` `^` among them.
Measured on TK5, text mode stores `[`/`]` as `0xBA`/`0xBB` (the 037 positions),
while the JCC C compiler on the guest expects `0xAD`/`0xBD` (1047), and text
reads render the 1047 bytes as unmappable characters. The `encoding` option on
`readDataset`/`readMember`/`writeDataset`/`writeMember` sidesteps the server's
translation: the bridge translates locally with the named table (`cp037` or
`cp1047`), pads every line to LRECL with EBCDIC blanks, and transfers the
records in binary mode. It needs a RECFM F/FB target with a known LRECL (looked
up from the catalog), and rejects a line longer than LRECL before anything is
written. Pair `writeMember … encoding: "cp1047"` with `submitJobFromDataset`
to run C source with real brackets without resorting to trigraphs.

### Optimistic locking

Pass `returnEtag: true` on a read to get an `ETag` header back; send it as
`ifMatch` on the write and mvsMF refuses with **412** if the target changed in
between. Always take the *next* `ifMatch` from the write's own response
(`returnEtag: true` on the write) — the stored form is normalized and the
pre-save stamp will not match. `ifNoneMatch` on a read answers **304** with no
body while the content is unchanged.

### Pagination

`listDatasets`, `listMembers` and `listUssFiles` accept `maxItems`
(`X-IBM-Max-Items`); `listMembers` also filters with `pattern` (`*`, `%`) and
resumes with `start`. A cut-short page carries `moreRows: true` — the key is
absent, not `false`, on a complete one. `getHardcopyLog` pages with
`nextTimestamp` → `timestamp`.

The `set-cookie` header (mvsMF's `LtpaToken2` session token) is stripped from
every response before it reaches the model.

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
