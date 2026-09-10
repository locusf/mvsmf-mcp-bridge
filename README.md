# zosmf-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
the IBM **z/OSMF REST API**, with an **mvsMF compatibility mode** for
[mvsMF](https://github.com/mvslovers/mvsmf) — the z/OSMF-compatible REST API
for classic MVS 3.8j systems running under
[Hercules](http://www.hercules-390.org/) (e.g.
[TK5](https://github.com/mvslovers/mvs-tk5)).

Each MCP tool call is translated 1:1 into one HTTP request against
`/zosmf/...`, using HTTP Basic Auth. The same server binary serves both
backends; `ZOSMF_MODE` picks which one you are talking to:

- **`zosmf`** (default) — a real z/OSMF. The full tool set is exposed.
- **`mvsmf`** — an mvsMF instance. Every tool, option and enum value that
  mvsMF does not implement is **removed from `tools/list`**, and a client
  that sends one anyway gets an explicit error
  (`… is not supported by mvsMF and is disabled in mvsmf compatibility mode`)
  instead of a confusing 400/404/500 from the server.

Why a separate server rather than
[`zowe/zowe-mcp`](https://github.com/zowe/zowe-mcp)? zowe-mcp only supports a
mock backend or a `--native` SSH backend via the
[Zowe Remote SSH SDK](https://github.com/zowe/zowex); it has no z/OSMF-REST
backend. Classic MVS 3.8j has no SSH daemon at all, so this project talks REST
directly and works against either implementation.

## Tools

| Tool | z/OSMF endpoint | mvsMF | Options |
|------|-----------------|:-----:|---------|
| `zosmfInfo` | `GET /zosmf/info` | ✓ | |
| `listDatasets` | `GET /zosmf/restfiles/ds` | ✓ | `volser`, `start`, `maxItems`, *`attributes`* |
| `createDataset` | `POST /zosmf/restfiles/ds/{name}` | ✓ | `like`, `dsorg`, `recfm`, `lrecl`, `blksize`, `primary`, `secondary`, `dirblk`, `alcunit`, *`dsntype`*, *`volser`*, *`unit`*, *`avgblk`*, *`storclass`*, *`mgntclass`*, *`dataclass`* |
| `deleteDataset` | `DELETE /zosmf/restfiles/ds/{name}` | ✓ | *`volser`* |
| `readDataset` | `GET /zosmf/restfiles/ds/{name}` | ✓ | `dataType`, `encoding`, `returnEtag`, `ifNoneMatch`, *`fileEncoding`*, *`recordRange`*, *`migratedRecall`*, *`volser`* |
| `writeDataset` | `PUT /zosmf/restfiles/ds/{name}` | ✓ | `content`/`contentBase64`, `dataType` (*`record`*), `encoding`, `ifMatch`, `returnEtag`, *`fileEncoding`*, *`migratedRecall`*, *`volser`* |
| `renameDataset` | `PUT /zosmf/restfiles/ds/{new}` `{"request":"rename"}` | ✓ | `newDsname` or `member`+`newMember`, *`enq`* |
| `copyDataset` | `PUT /zosmf/restfiles/ds/{to}` `{"request":"copy"}` | ✗ | `fromMember`, `toMember`, `fromVolser`, `alias`, `replace`, `enq` |
| `hsmRequest` | `PUT /zosmf/restfiles/ds/{name}` `{"request":"hrecall\|hmigrate\|hdelete"}` | ✗ | `wait`, `purge` |
| `listMembers` | `GET /zosmf/restfiles/ds/{name}/member` | ✓ | `pattern`, `start`, `maxItems`, *`attributes`*, *`volser`* |
| `readMember` | `GET /zosmf/restfiles/ds/{name}({member})` | ✓ | as `readDataset` |
| `writeMember` | `PUT /zosmf/restfiles/ds/{name}({member})` | ✓ | as `writeDataset` |
| `deleteMember` | `DELETE /zosmf/restfiles/ds/{name}({member})` | ✓ | *`volser`* |
| `listUssFiles` | `GET /zosmf/restfiles/fs?path=...` | ✓ | `maxItems`, *`name`*, *`depth`*, *`type`*, *`filesys`*, *`symlinks`* |
| `readUssFile` | `GET /zosmf/restfiles/fs/{filepath}` | ✓ | `dataType`, `returnEtag`, `ifNoneMatch`, *`fileEncoding`*, *`recordRange`* |
| `writeUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` | ✓ | `content`/`contentBase64`, `dataType`, `ifMatch`, `returnEtag`, *`fileEncoding`* |
| `createUssFile` | `POST /zosmf/restfiles/fs/{filepath}` | ✓ | `isDirectory`, `mode` |
| `deleteUssFile` | `DELETE /zosmf/restfiles/fs/{filepath}` | ✓ | `recursive` |
| `chmodUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` `{"request":"chmod"}` | ✗ | `mode`, `recursive`, `links` |
| `chownUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` `{"request":"chown"}` | ✗ | `owner`, `group`, `recursive`, `links` |
| `chtagUssFile` | `PUT /zosmf/restfiles/fs/{filepath}` `{"request":"chtag"}` | ✓¹ | `action`, *`type`*, *`codeset`*, *`recursive`*, *`links`* |
| `moveUssFile` | `PUT /zosmf/restfiles/fs/{to}` `{"request":"move"}` | ✗ | `overwrite` |
| `copyUssFile` | `PUT /zosmf/restfiles/fs/{to}` `{"request":"copy"}` | ✗ | `overwrite`, `recursive` |
| `listJobs` | `GET /zosmf/restjobs/jobs` | ✓ | `owner`, `prefix`, `jobid`, `status`, `maxJobs`, `execData`, *`userCorrelator`* |
| `getJobStatus` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}` | ✓ | `execData`, *`stepData`* |
| `listJobFiles` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files` | ✓ | |
| `readJobFile` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records` | ✓ | *`recordRange`*, *`fileEncoding`* |
| `getJobJcl` | `GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/JCL/records` | ✗ | |
| `submitJob` | `PUT /zosmf/restjobs/jobs` (inline JCL, `text/plain`) | ✓ | *`intrdrClass`*, *`intrdrRecfm`*, *`intrdrLrecl`*, *`symbols`*, *`notificationUrl`* |
| `submitJobFromDataset` | `PUT /zosmf/restjobs/jobs` (`{"file": "//'DSN(MEM)'"}`) | ✓ | *`intrdrClass`*, *`symbols`*, *`notificationUrl`* |
| `submitJobFromUssFile` | `PUT /zosmf/restjobs/jobs` (`{"file": "/u/..."}`) | ✗ | `intrdrClass`, `symbols`, `notificationUrl` |
| `purgeJob` | `DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}` | ✓ | *`synchronous`* |
| `cancelJob` | `PUT /zosmf/restjobs/jobs/{jobname}/{jobid}` `{"request":"cancel"}` | ✗ | `synchronous` |
| `holdJob` | `PUT …` `{"request":"hold"}` | ✗ | `synchronous` |
| `releaseJob` | `PUT …` `{"request":"release"}` | ✗ | `synchronous` |
| `changeJobClass` | `PUT …` `{"class":"X"}` | ✗ | `class`, `synchronous` |
| `issueConsoleCommand` | `PUT /zosmf/restconsoles/consoles/{consoleName}` | ✓ | `async`, `solKey`, `unsolKey`, `unsolDetectSync`, `unsolDetectTimeout`, `detectTime`, *`system`* |
| `getConsoleMessages` | `GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}` | ✓ | |
| `getConsoleDetections` | `GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}` | ✓ | |
| `getHardcopyLog` | `GET /zosmf/restconsoles/v1/log` | ✓ | `timeRange`, `time`, `timestamp`, `direction`, `hardcopy`, `sysName` |
| `issueTsoCommand` | `PUT /zosmf/tsoApp/v1/tso` (stateless) | ✗ | `account`, `proc`, `regionSize`, `characterSet`, `codePage` |

*Italic* options and ✗ tools are **z/OSMF only**: in `ZOSMF_MODE=mvsmf` they
are absent from the schema and refused if sent. ¹ mvsMF accepts `chtag` but
has no file tagging: `list` reports untagged, `set`/`remove` are no-ops.

The mvsMF column follows mvsMF's own
[endpoint reference](https://github.com/mvslovers/mvsmf/blob/main/docs/endpoints/README.md)
(`X-IBM-Data-Type: record` on writes is "accepted and not implemented", the
`-(volser)` routes were withdrawn, USS utilities other than `chtag` answer
400, the internal-reader headers are validated but fixed, and there is no job
modify, JCL retrieval, HSM, copy or TSO service). Not bridged on either
backend: `/zosmf/services/authenticate` (Basic credentials go on every call
and both servers accept that), workflows, software management, and the
stateful TSO session API.

> **Caution:** `submitJob*`, `purgeJob`, `cancelJob`, `holdJob`,
> `releaseJob`, `changeJobClass`, `createDataset`, `deleteDataset`,
> `writeDataset`, `renameDataset`, `copyDataset`, `hsmRequest`,
> `writeMember`, `deleteMember`, `writeUssFile`, `createUssFile`,
> `deleteUssFile`, `chmodUssFile`, `chownUssFile`, `chtagUssFile`,
> `moveUssFile`, `copyUssFile`, `issueConsoleCommand` and `issueTsoCommand`
> all cause real, sometimes irreversible effects on the target system —
> running batch work, cancelling jobs, allocating, overwriting or deleting
> data, and issuing operator commands that can affect the whole system
> (mvsMF applies **no** per-command authorization on the console endpoint).
> Treat them with the same care as any tool that can run arbitrary code.

### Transfer modes and code pages

Data set and USS reads/writes default to **text** mode: the server converts
between ASCII and EBCDIC and splits records at newlines. Other modes are
exposed through `dataType`:

- `binary` — bytes as stored. Reads return `bodyBase64`; writes take
  `contentBase64`. Binary writes are split at LRECL boundaries.
- `record` — binary with a 4-byte big-endian length before each record.
  Supported both ways on z/OSMF; on mvsMF it is read-only (the write path
  frames no length prefix), so `dataType: "record"` is dropped from the write
  schemas in mvsmf mode.

Code page selection differs between the two backends:

- **z/OSMF** — `fileEncoding` sets `X-IBM-Data-Type: text;fileEncoding=IBM-1047`
  (or any code page the host supports) and the server does the translation.
- **mvsMF** — text translation uses one fixed table, and a few characters sit
  on different EBCDIC code points in IBM-037 and IBM-1047 — `[` `]` `^` among
  them. Measured on TK5, text mode stores `[`/`]` as `0xBA`/`0xBB` (the 037
  positions), while the JCC C compiler on the guest expects `0xAD`/`0xBD`
  (1047), and text reads render the 1047 bytes as unmappable characters. The
  `encoding` option on `readDataset`/`readMember`/`writeDataset`/`writeMember`
  sidesteps the server: the bridge translates locally with the named table
  (`cp037` or `cp1047`), pads every line to LRECL with EBCDIC blanks, and
  transfers the records in binary mode. It needs a RECFM F/FB target with a
  known LRECL (looked up from the catalog), and rejects a line longer than
  LRECL before anything is written. Pair `writeMember … encoding: "cp1047"`
  with `submitJobFromDataset` to run C source with real brackets without
  resorting to trigraphs. `encoding` also works against z/OSMF, but
  `fileEncoding` is the native way there.

### Optimistic locking

Pass `returnEtag: true` on a read to get an `ETag` header back; send it as
`ifMatch` on the write and the server refuses with **412** if the target
changed in between. Always take the *next* `ifMatch` from the write's own
response (`returnEtag: true` on the write) — the stored form is normalized and
the pre-save stamp will not match. `ifNoneMatch` on a read answers **304**
with no body while the content is unchanged.

### Pagination

`listDatasets`, `listMembers` and `listUssFiles` accept `maxItems`
(`X-IBM-Max-Items`); `listMembers` also filters with `pattern` (`*`, `%`) and
resumes with `start`. A cut-short page carries `moreRows: true` — the key is
absent, not `false`, on a complete one. `getHardcopyLog` pages with
`nextTimestamp` → `timestamp`.

In zosmf mode `listDatasets` sends `X-IBM-Attributes: base` by default so the
listing carries DCB attributes like mvsMF's does (z/OSMF itself would return
names only); pass `attributes: "dsname"` for the lean form.

The `set-cookie` header (the `LtpaToken2` session token both servers return)
is stripped from every response before it reaches the model, and every
request carries `X-CSRF-ZOSMF-HEADER`, which z/OSMF requires and mvsMF
ignores.

## Requirements

- Node.js >= 18 (for built-in `fetch`)
- Either a z/OSMF instance (usually HTTPS on port 443/10443) **or** an mvsMF
  instance (HTTPD + mvsMF module registered), plus valid credentials on that
  system

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
| `ZOSMF_BASE_URL` | no (default `http://127.0.0.1:8090`) | Base URL of z/OSMF or mvsMF, e.g. `https://zosmf.example.com:443` |
| `ZOSMF_USER` | yes | Userid |
| `ZOSMF_PASSWORD` | yes | Password |
| `ZOSMF_MODE` | no | `zosmf` (default) or `mvsmf` (compatibility mode, see above) |
| `ZOSMF_INSECURE_TLS` | no | `true` to accept a self-signed z/OSMF certificate. For a proper CA bundle use Node's `NODE_EXTRA_CA_CERTS=/path/ca.pem` instead |

The `MVSMF_BASE_URL` / `MVSMF_USER` / `MVSMF_PASSWORD` names from 1.x are
still read as fallbacks, and if only those are set (no `ZOSMF_BASE_URL`,
no `ZOSMF_MODE`) the mode defaults to `mvsmf`, so existing configurations
keep working unchanged.

## Running standalone

```bash
# against z/OSMF
ZOSMF_BASE_URL=https://zosmf.example.com:443 \
ZOSMF_USER=IBMUSER ZOSMF_PASSWORD=secret \
node index.js

# against mvsMF on a TK5 guest
ZOSMF_MODE=mvsmf \
ZOSMF_BASE_URL=http://127.0.0.1:8090 \
ZOSMF_USER=HERC01 ZOSMF_PASSWORD=CUL8TR \
node index.js
```

The server speaks MCP over stdio and logs a one-line startup banner to
stderr, including the mode and how many of the tools are enabled.

## Using with an MCP client

### GitHub Copilot CLI

Add to `.mcp.json` (or `.github/mcp.json`) at your project root, or to
`~/.copilot/mcp-config.json` for all projects:

```json
{
  "mcpServers": {
    "zosmf": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mvsmf-mcp-bridge/index.js"],
      "env": {
        "ZOSMF_MODE": "mvsmf",
        "ZOSMF_BASE_URL": "http://127.0.0.1:8090",
        "ZOSMF_USER": "HERC01",
        "ZOSMF_PASSWORD": "CUL8TR"
      },
      "tools": ["*"]
    }
  }
}
```

Drop `ZOSMF_MODE` (or set it to `zosmf`) and point `ZOSMF_BASE_URL` at a
z/OSMF host to get the full tool set.

### Other MCP clients (Claude Code, Cursor, VS Code, etc.)

Use the same server block shape — see each client's MCP documentation for
where its config file lives and whether it expects `mcpServers` or
`servers` as the top-level key.

## License

MIT — see [LICENSE](LICENSE).
