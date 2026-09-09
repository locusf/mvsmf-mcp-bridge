#!/usr/bin/env node
// Minimal MCP server that bridges to a running mvsMF (z/OSMF-compatible REST
// API) instance on this repository's MVS 3.8j / Hercules guest. Speaks MCP
// over stdio; each tool call is translated into one mvsMF REST call using
// Basic Auth. See docs/endpoints/ in https://github.com/mvslovers/mvsmf for
// the upstream API reference this bridge implements against.
//
// Config (env vars):
//   MVSMF_BASE_URL   e.g. http://127.0.0.1:8090        (required)
//   MVSMF_USER       TSO userid                        (required)
//   MVSMF_PASSWORD   TSO password                       (required)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = process.env.MVSMF_BASE_URL || 'http://127.0.0.1:8090';
const USER = process.env.MVSMF_USER;
const PASSWORD = process.env.MVSMF_PASSWORD;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function authHeader() {
  if (!USER || !PASSWORD) return {};
  const b64 = Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${b64}` };
}

// Response headers minus the session cookie: mvsMF answers every Basic request
// with a Set-Cookie: LtpaToken2=... and there is no reason to echo a bearer
// credential into the model transcript.
function responseHeaders(res) {
  const h = Object.fromEntries(res.headers);
  delete h['set-cookie'];
  return h;
}

// binary: true  -> body returned as base64 in `bodyBase64` (plus `byteLength`);
//                  falls back to text/JSON parsing on non-2xx so error bodies
//                  stay readable.
async function mvsmfFetch(path, { method = 'GET', headers = {}, body, binary = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...authHeader(), ...headers },
    body,
  });
  const out = { status: res.status, ok: res.ok, headers: responseHeaders(res) };
  if (binary && res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    out.bodyBase64 = buf.toString('base64');
    out.byteLength = buf.length;
    return out;
  }
  const text = await res.text();
  try {
    out.body = text ? JSON.parse(text) : undefined;
  } catch {
    out.body = text;
  }
  return out;
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const enc = encodeURIComponent;

function ussPath(path) {
  return path.split('/').filter(Boolean).map(enc).join('/');
}

function dsPath(dsname, member) {
  return `/zosmf/restfiles/ds/${enc(dsname)}${member ? `(${enc(member)})` : ''}`;
}

function jobPath(jobname, jobid) {
  return `/zosmf/restjobs/jobs/${enc(jobname)}/${enc(jobid)}`;
}

function consolePath(consoleName) {
  return `/zosmf/restconsoles/consoles/${enc(consoleName || 'defcn')}`;
}

// ---------------------------------------------------------------------------
// Code pages
//
// mvsMF's text mode translates ASCII<->EBCDIC with one fixed table. Some
// characters land on different EBCDIC code points in IBM-037 and IBM-1047
// ('[' ']' '^' and NL among them), and compilers on the guest (JCC, for one)
// expect the 1047 positions, which the text path does not produce. The
// `encoding` option on the dataset read/write tools sidesteps the server's
// translation entirely: the bridge translates locally with the table named,
// pads each line to LRECL, and transfers the records in binary mode.
//
// Tables map a Latin-1 code unit (0x00-0xFF) to its EBCDIC byte.
// ---------------------------------------------------------------------------

const CP_ENC = {
  cp037: Buffer.from(
    '00010203372d2e2f1605250b0c0d0e0f101112133c3d322618193f271c1d1e1f405a7f7b5b6c507d4d5d5c4e6b604b61f0f1f2f3f4f5f6f7f8f97a5e4c7e6e6f7cc1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7d8d9e2e3e4e5e6e7e8e9bae0bbb06d79818283848586878889919293949596979899a2a3a4a5a6a7a8a9c04fd0a107202122232415061728292a2b2c090a1b30311a333435360838393a3b04143eff41aa4ab19fb26ab5bdb49a8a5fcaafbc908feafabea0b6b39dda9b8bb7b8b9ab6465626663679e687471727378757677ac69edeeebefecbf80fdfefbfcadae594445424643479c4854515253585556578c49cdcecbcfcce170dddedbdc8d8edf',
    'hex'
  ),
  cp1047: Buffer.from(
    '00010203372d2e2f1605150b0c0d0e0f101112133c3d322618193f271c1d1e1f405a7f7b5b6c507d4d5d5c4e6b604b61f0f1f2f3f4f5f6f7f8f97a5e4c7e6e6f7cc1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7d8d9e2e3e4e5e6e7e8e9ade0bd5f6d79818283848586878889919293949596979899a2a3a4a5a6a7a8a9c04fd0a107202122232425061728292a2b2c090a1b30311a333435360838393a3b04143eff41aa4ab19fb26ab5bbb49a8ab0caafbc908feafabea0b6b39dda9b8bb7b8b9ab6465626663679e687471727378757677ac69edeeebefecbf80fdfefbfcbaae594445424643479c4854515253585556578c49cdcecbcfcce170dddedbdc8d8edf',
    'hex'
  ),
};

function invertTable(t) {
  const r = Buffer.alloc(256);
  for (let a = 0; a < 256; a++) r[t[a]] = a;
  return r;
}

const CP_DEC = Object.fromEntries(Object.entries(CP_ENC).map(([k, t]) => [k, invertTable(t)]));

const EBCDIC_SPACE = 0x40;
const EBCDIC_QMARK = 0x6f; // substitute for characters outside Latin-1

// Look the data set up in the catalog listing to learn RECFM/LRECL.
async function datasetAttrs(dsname) {
  const want = dsname.toUpperCase();
  const r = await mvsmfFetch(`/zosmf/restfiles/ds?${new URLSearchParams({ dslevel: want })}`);
  const item = r.ok && Array.isArray(r.body?.items) ? r.body.items.find((i) => i.dsname === want) : undefined;
  if (!item) throw new Error(`Cannot read attributes of ${want} from the catalog (list status ${r.status})`);
  // mvsMF emits lrecl/blksize as strings; normalize so arithmetic stays numeric.
  return { ...item, lrecl: Number(item.lrecl) || 0, blksize: Number(item.blksize) || 0 };
}

function requireFixed(recfm, lrecl, what) {
  if (!/^F/.test(recfm || '') || !lrecl) {
    throw new Error(`${what} requires a RECFM F/FB data set with a known LRECL (got RECFM=${recfm}, LRECL=${lrecl})`);
  }
}

// Text -> fixed-length EBCDIC records, one per line, padded with EBCDIC blanks.
function encodeRecords(text, cp, lrecl) {
  const table = CP_ENC[cp];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = Buffer.alloc(lines.length * lrecl, EBCDIC_SPACE);
  lines.forEach((line, n) => {
    if (line.length > lrecl) {
      throw new Error(`Line ${n + 1} is ${line.length} characters; LRECL is ${lrecl}. Nothing was written.`);
    }
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      out[n * lrecl + i] = c < 256 ? table[c] : EBCDIC_QMARK;
    }
  });
  return out;
}

// Fixed-length EBCDIC records -> text. Trailing blanks are stripped from each
// record; trailing records that are entirely blank or NUL (block padding a
// binary member read can include) are dropped.
function decodeRecords(buf, cp, lrecl) {
  const table = CP_DEC[cp];
  const lines = [];
  for (let off = 0; off < buf.length; off += lrecl) {
    const rec = buf.subarray(off, Math.min(off + lrecl, buf.length));
    let s = '';
    let blank = true;
    for (const b of rec) {
      if (b !== EBCDIC_SPACE && b !== 0x00) blank = false;
      s += String.fromCharCode(table[b]);
    }
    lines.push(blank ? '' : s.replace(/ +$/, ''));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared option handling for data set / USS reads and writes
// ---------------------------------------------------------------------------

function readHeaders(args) {
  const h = {};
  if (args.dataType && args.dataType !== 'text') h['X-IBM-Data-Type'] = args.dataType;
  if (args.returnEtag) h['X-IBM-Return-Etag'] = 'true';
  if (args.ifNoneMatch) h['If-None-Match'] = args.ifNoneMatch;
  return h;
}

function writeHeaders(args, dataType) {
  const h = { 'Content-Type': dataType === 'binary' ? 'application/octet-stream' : 'text/plain' };
  if (dataType === 'binary') h['X-IBM-Data-Type'] = 'binary';
  if (args.returnEtag) h['X-IBM-Return-Etag'] = 'true';
  if (args.ifMatch) h['If-Match'] = args.ifMatch;
  return h;
}

// Resolve the body for a write from content / contentBase64 / encoding.
// Returns { body, dataType } where dataType is 'text' or 'binary'.
async function writeBody(args, dsname) {
  if (args.dataType === 'record') {
    throw new Error('dataType "record" is not implemented for writes by mvsMF; use "binary" for a byte-exact round trip.');
  }
  if (args.encoding) {
    if (args.content === undefined) throw new Error('encoding requires `content` (text).');
    if (args.contentBase64 !== undefined) throw new Error('encoding and contentBase64 are mutually exclusive.');
    const { recfm, lrecl } = await datasetAttrs(dsname);
    requireFixed(recfm, lrecl, `encoding=${args.encoding}`);
    return { body: encodeRecords(args.content, args.encoding, lrecl), dataType: 'binary' };
  }
  if (args.contentBase64 !== undefined) {
    if (args.content !== undefined) throw new Error('content and contentBase64 are mutually exclusive.');
    return { body: Buffer.from(args.contentBase64, 'base64'), dataType: 'binary' };
  }
  if (args.content !== undefined) {
    if (args.dataType === 'binary') return { body: Buffer.from(args.content, 'utf8'), dataType: 'binary' };
    return { body: args.content, dataType: 'text' };
  }
  throw new Error('Either `content` or `contentBase64` is required.');
}

async function readDatasetLike(path, dsname, args) {
  if (args.encoding) {
    if (args.dataType && args.dataType !== 'binary') {
      throw new Error('encoding implies binary transfer; do not combine it with dataType "text" or "record".');
    }
    const r = await mvsmfFetch(path, { headers: readHeaders({ ...args, dataType: 'binary' }), binary: true });
    if (!r.ok || r.bodyBase64 === undefined) return textResult(r);
    const { recfm, lrecl } = await datasetAttrs(dsname);
    requireFixed(recfm, lrecl, `encoding=${args.encoding}`);
    const buf = Buffer.from(r.bodyBase64, 'base64');
    const { bodyBase64, byteLength, ...rest } = r;
    return textResult({ ...rest, encoding: args.encoding, lrecl, recfm, byteLength, body: decodeRecords(buf, args.encoding, lrecl) });
  }
  const binary = args.dataType === 'binary' || args.dataType === 'record';
  return textResult(await mvsmfFetch(path, { headers: readHeaders(args), binary }));
}

async function writeDatasetLike(path, dsname, args) {
  const { body, dataType } = await writeBody(args, dsname);
  return textResult(await mvsmfFetch(path, { method: 'PUT', headers: writeHeaders(args, dataType), body }));
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const DS_READ_OPTS = {
  dataType: {
    type: 'string',
    enum: ['text', 'binary', 'record'],
    description:
      'Transfer mode (X-IBM-Data-Type). text (default): server EBCDIC->ASCII conversion, body returned as text. binary: raw bytes, returned as bodyBase64. record: like binary with a 4-byte big-endian length before each record, returned as bodyBase64.',
  },
  encoding: {
    type: 'string',
    enum: ['cp037', 'cp1047'],
    description:
      'Fetch in binary and translate locally with this EBCDIC code page instead of the server\'s text conversion (RECFM F/FB only). Use cp1047 to read source whose [ ] ^ were stored at the IBM-1047 code points (e.g. JCC C source), which the text mode cannot represent. Mutually exclusive with dataType.',
  },
  returnEtag: { type: 'boolean', description: 'Ask for an ETag (X-IBM-Return-Etag) to use as ifMatch on a later write.' },
  ifNoneMatch: { type: 'string', description: 'Conditional read: an ETag from an earlier read. Answers 304 with no body if unchanged.' },
};

const DS_WRITE_OPTS = {
  content: { type: 'string', description: 'Text content to write. Records are split at newlines.' },
  contentBase64: { type: 'string', description: 'Raw bytes (base64) to write in binary mode. Mutually exclusive with content.' },
  dataType: {
    type: 'string',
    enum: ['text', 'binary'],
    description: 'Transfer mode for `content`. text (default): server ASCII->EBCDIC conversion. binary: bytes are stored as-is, split at LRECL. contentBase64 always implies binary.',
  },
  encoding: {
    type: 'string',
    enum: ['cp037', 'cp1047'],
    description:
      'Translate `content` locally with this EBCDIC code page, pad each line to LRECL and write in binary, bypassing the server\'s text conversion (RECFM F/FB only; lines longer than LRECL are rejected before anything is written). Use cp1047 so [ ] ^ land where JCC and other 1047-expecting tools want them.',
  },
  ifMatch: { type: 'string', description: 'Optimistic lock: an ETag from an earlier read (or "*" = must exist). The write is refused with 412 if the target changed.' },
  returnEtag: { type: 'boolean', description: 'Return the ETag of the target as it stands after the write (needed for the next ifMatch).' },
};

const USS_READ_OPTS = {
  dataType: { type: 'string', enum: ['text', 'binary'], description: 'text (default): server EBCDIC->ASCII conversion. binary: raw bytes returned as bodyBase64.' },
  returnEtag: DS_READ_OPTS.returnEtag,
  ifNoneMatch: DS_READ_OPTS.ifNoneMatch,
};

const USS_WRITE_OPTS = {
  content: { type: 'string', description: 'Text content to write.' },
  contentBase64: DS_WRITE_OPTS.contentBase64,
  dataType: { type: 'string', enum: ['text', 'binary'], description: 'Transfer mode for `content`. contentBase64 always implies binary.' },
  ifMatch: DS_WRITE_OPTS.ifMatch,
  returnEtag: DS_WRITE_OPTS.returnEtag,
};

const TOOLS = [
  {
    name: 'mvsmfInfo',
    description:
      'Get z/OSMF system information from the mvsMF instance (GET /zosmf/info). Requires valid credentials; a real z/OSMF also 401s this endpoint without auth.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // --- Datasets ---
  {
    name: 'listDatasets',
    description:
      'List cataloged data sets matching a filter pattern (GET /zosmf/restfiles/ds). Supports wildcards like "USER.*" or "USER.**". Returns dsorg/recfm/lrecl/blksize/vol per entry; a truncated list carries moreRows: true.',
    inputSchema: {
      type: 'object',
      properties: {
        dslevel: { type: 'string', description: 'Data set name filter, e.g. "SYS1.**" or "USER.TEST.DATA"' },
        volser: { type: 'string', description: 'Optional volume serial filter' },
        start: { type: 'string', description: 'Optional starting data set name for pagination (inclusive)' },
        maxItems: { type: 'integer', description: 'Optional max items (X-IBM-Max-Items), 0 = unlimited' },
      },
      required: ['dslevel'],
      additionalProperties: false,
    },
  },
  {
    name: 'createDataset',
    description:
      'Allocate a new sequential (PS) or partitioned (PO) data set (POST /zosmf/restfiles/ds/{name}). Either give dsorg/recfm/lrecl/blksize/primary explicitly, or `like` an existing data set and override any of them. Caution: allocates real DASD space on the guest. Every allocation failure (name exists, no space, not authorized) answers 500 "Dynamic allocation Error".',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Fully qualified name of the data set to create' },
        like: { type: 'string', description: 'Model data set: DSORG/RECFM/LRECL/BLKSIZE and space are taken from it unless overridden' },
        dsorg: { type: 'string', enum: ['PS', 'PO'], description: 'PS = sequential, PO = partitioned' },
        recfm: { type: 'string', description: 'Record format, e.g. FB, VB, U' },
        lrecl: { type: 'integer', description: 'Logical record length' },
        blksize: { type: 'integer', description: 'Block size' },
        primary: { type: 'integer', description: 'Primary space allocation (in alcunit)' },
        secondary: { type: 'integer', description: 'Secondary space allocation (default 0)' },
        dirblk: { type: 'integer', description: 'Directory blocks for a PDS (default 0; 20 when modelling a PO target with `like`)' },
        alcunit: { type: 'string', enum: ['TRK', 'CYL', 'BLK'], description: 'Allocation unit (default TRK)' },
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteDataset',
    description:
      'Uncatalog and scratch a data set (DELETE /zosmf/restfiles/ds/{name}). Caution: irreversibly destroys the data set and all its members.',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' } },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'readDataset',
    description:
      'Read the content of a sequential (PS) data set (GET /zosmf/restfiles/ds/{name}). PDS data sets return 400; use readMember instead. Supports text/binary/record transfer, local code-page decoding, and ETag conditional reads.',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' }, ...DS_READ_OPTS },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeDataset',
    description:
      'Write/overwrite the content of a sequential (PS) data set (PUT /zosmf/restfiles/ds/{name}). Caution: replaces the existing content of a real MVS data set; an empty body truncates it. The data set must already exist (see createDataset).',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' }, ...DS_WRITE_OPTS },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'listMembers',
    description:
      'List members of a PDS (GET /zosmf/restfiles/ds/{name}/member). Use pattern/start/maxItems to page a large directory instead of pulling it whole; a truncated page carries moreRows: true.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        pattern: { type: 'string', description: 'Member name filter: * matches any run of characters, % exactly one; e.g. "JES2*", "IEF%%%01"' },
        start: { type: 'string', description: 'Starting member name for pagination (inclusive, EBCDIC collation)' },
        maxItems: { type: 'integer', description: 'Max members to return (X-IBM-Max-Items), 0/omitted = all' },
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'readMember',
    description:
      'Read a single PDS member (GET /zosmf/restfiles/ds/{name}({member})). Supports text/binary/record transfer, local code-page decoding (encoding=cp1047 for JCC-style source with real brackets), and ETag conditional reads.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
        ...DS_READ_OPTS,
      },
      required: ['dsname', 'member'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeMember',
    description:
      'Write/overwrite a single PDS member (PUT /zosmf/restfiles/ds/{name}({member})), creating it if absent. Caution: replaces the existing content of a real MVS PDS member; an empty body truncates it. Use ifMatch to avoid clobbering a concurrent edit.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
        ...DS_WRITE_OPTS,
      },
      required: ['dsname', 'member'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteMember',
    description:
      'Delete a PDS member (DELETE /zosmf/restfiles/ds/{name}({member})). Caution: irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
      },
      required: ['dsname', 'member'],
      additionalProperties: false,
    },
  },

  // --- USS (UNIX System Services) ---
  {
    name: 'listUssFiles',
    description:
      'List a USS directory, or stat a single file (GET /zosmf/restfiles/fs?path=...). A truncated listing carries moreRows: true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS directory or file path, e.g. "/u/herc01"' },
        maxItems: { type: 'integer', description: 'Max entries to return (X-IBM-Max-Items). Server default 1000; 0 = unlimited' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'readUssFile',
    description: 'Read the content of a USS file (GET /zosmf/restfiles/fs/{filepath}). Files are capped at 64 KB by UFSD.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute USS file path, e.g. "/u/herc01/profile"' }, ...USS_READ_OPTS },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeUssFile',
    description:
      'Write/overwrite the content of a USS file (PUT /zosmf/restfiles/fs/{filepath}), creating it if absent. Caution: replaces the existing content of a real file. Files are capped at 64 KB by UFSD.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute USS file path' }, ...USS_WRITE_OPTS },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'createUssFile',
    description:
      'Create a new USS file or directory (POST /zosmf/restfiles/fs/{filepath}). Caution: creates real filesystem entries on the guest. Fails with 400 if the path already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path to create' },
        isDirectory: { type: 'boolean', description: 'Create a directory instead of a file. Default false.' },
        mode: { type: 'string', description: 'Optional POSIX permission string, e.g. "rwxr-xr-x"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteUssFile',
    description:
      'Delete a USS file or directory (DELETE /zosmf/restfiles/fs/{filepath}). Caution: irreversibly removes a real file or directory from the guest.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path to delete' },
        recursive: { type: 'boolean', description: 'Recursively delete a non-empty directory. Default false.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  // --- Jobs ---
  {
    name: 'listJobs',
    description: 'List JES2 jobs (GET /zosmf/restjobs/jobs). Owner defaults to the authenticated user; pass owner "*" for everyone.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Job owner filter, "*" for all owners' },
        prefix: { type: 'string', description: 'Job name prefix filter, "*" for all' },
        jobid: { type: 'string', description: 'Specific job id filter' },
        status: { type: 'string', description: 'INPUT|ACTIVE|OUTPUT|* (also XMIT/SETUP/RECEIVE/UNKNOWN on 3.8j)' },
        maxJobs: { type: 'integer', description: 'Max jobs returned, 1-1000 (default 1000)' },
        execData: { type: 'boolean', description: 'Include exec-started / exec-ended timestamps (UTC)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getJobStatus',
    description:
      "Get a job's status (GET /zosmf/restjobs/jobs/{jobname}/{jobid}). retcode is null until the job finishes (and always null without the SYZJ201 usermod).",
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
        execData: { type: 'boolean', description: 'Include exec-started / exec-ended timestamps (UTC)' },
      },
      required: ['jobname', 'jobid'],
      additionalProperties: false,
    },
  },
  {
    name: 'listJobFiles',
    description: 'List spool files for a job (GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files).',
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
      },
      required: ['jobname', 'jobid'],
      additionalProperties: false,
    },
  },
  {
    name: 'readJobFile',
    description:
      'Read the record content of one job spool file (GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records). A 404 with reason 10 means JES2 already purged that spool output.',
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
        ddid: { type: 'string', description: 'Spool file id (ddid) from listJobFiles' },
      },
      required: ['jobname', 'jobid', 'ddid'],
      additionalProperties: false,
    },
  },
  {
    name: 'submitJob',
    description:
      'Submit a job by inline JCL text (PUT /zosmf/restjobs/jobs, Content-Type: text/plain). Use with care: this executes real batch work on the guest MVS system. mvsMF appends USER=/PASSWORD= (and NOTIFY=$MVSMF if the card has none) to the JOB statement. The JOB statement needs a programmer name or MVS flushes it with a JCL ERROR.',
    inputSchema: {
      type: 'object',
      properties: { jcl: { type: 'string', description: 'Full inline JCL text, including the JOB card' } },
      required: ['jcl'],
      additionalProperties: false,
    },
  },
  {
    name: 'submitJobFromDataset',
    description:
      'Submit a job whose JCL is in a data set or PDS member (PUT /zosmf/restjobs/jobs, Content-Type: application/json). Use with care: this executes real batch work on the guest MVS system. Unlike inline submit, the JCL bytes are read from DASD as stored, so source written with encoding=cp1047 keeps its code points.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Data set holding the JCL, e.g. "HERC01.JCL(MYJOB)" or "HERC01.JOB.JCL"' },
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'purgeJob',
    description:
      'Purge/cancel a job from JES2 (DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}). Caution: removes a job from the queue, including an active one; irreversible. Started tasks and TSO users are refused with 400.',
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
      },
      required: ['jobname', 'jobid'],
      additionalProperties: false,
    },
  },

  // --- Console services ---
  {
    name: 'issueConsoleCommand',
    description:
      'Issue an MVS operator command (PUT /zosmf/restconsoles/consoles/{consoleName}). Caution: operator commands can affect the whole shared MVS guest (start/stop subsystems, cancel jobs, etc) and mvsMF applies no per-command authorization. Returns cmd-response (what arrived before the reply went quiet, ~0.3-3 s) plus a cmd-response-key for getConsoleMessages; with unsolKey also a detection-key for getConsoleDetections. A 429 or 503/8/17 means the command was NOT issued and may be retried; 503/8/15 means it WAS issued but the response was lost.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Operator command text, max 126 chars, e.g. "D T" or "D A,L"' },
        consoleName: { type: 'string', description: 'Console name, 2-8 chars. Default "defcn".' },
        async: { type: 'boolean', description: 'Return only the response key, not cmd-response (no faster; saves payload only).' },
        solKey: { type: 'string', description: 'Substring to look for in the solicited response; sets sol-key-detected in the result.' },
        unsolKey: { type: 'string', description: 'Arm detection of an unsolicited message containing this substring (e.g. "FTPD054I" after "S FTPD"). Returns a detection-key.' },
        unsolDetectSync: { type: 'boolean', description: 'With unsolKey: block up to unsolDetectTimeout and return status/msg inline instead of a detection-key.' },
        unsolDetectTimeout: { type: 'integer', description: 'Seconds to block in sync detection (default 20, max 60).' },
        detectTime: { type: 'integer', description: 'Seconds the async detection stays armed (default 30).' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'getConsoleMessages',
    description:
      'Collect response lines that arrived after issueConsoleCommand returned (GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}). Each call returns only new lines; "" means nothing new (or the key aged out of the trace table).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'cmd-response-key returned by issueConsoleCommand' },
        consoleName: { type: 'string', description: 'Console name used at issue time. Default "defcn".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'getConsoleDetections',
    description:
      'Poll an unsolicited-message detection armed by issueConsoleCommand with unsolKey (GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}). status is waiting, detected (msg holds the message) or expired. An unknown/evicted key answers 500 / 5 / 9.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'detection-key returned by issueConsoleCommand' },
        consoleName: { type: 'string', description: 'Console name used at issue time. Default "defcn".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'getHardcopyLog',
    description:
      'Retrieve hardcopy log (SYSLOG / Master Trace Table) messages over a time window (GET /zosmf/restconsoles/v1/log). Default: the last 10 minutes ending now. Items are oldest-first; nextTimestamp is the far edge of the window for paging.',
    inputSchema: {
      type: 'object',
      properties: {
        timeRange: { type: 'string', description: 'Window size: 1-999 followed by s, m or h, e.g. "2m", "1h". Default "10m".' },
        time: { type: 'string', description: 'ISO 8601 UTC anchor, e.g. "2026-06-30T02:00:00Z". Default now.' },
        timestamp: { type: 'integer', description: 'UNIX millisecond anchor; overrides time. Use a previous nextTimestamp to page.' },
        direction: { type: 'string', enum: ['backward', 'forward'], description: 'Direction from the anchor. Default backward.' },
        hardcopy: { type: 'string', enum: ['syslog', 'operlog'], description: 'Log source; operlog falls back to SYSLOG on 3.8j.' },
        sysName: { type: 'string', description: 'System name, max 8 chars. Only the local system is supported.' },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function setIf(params, key, value) {
  if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
}

async function callTool(name, args) {
  switch (name) {
    case 'mvsmfInfo':
      return textResult(await mvsmfFetch('/zosmf/info'));

    // --- Datasets ---
    case 'listDatasets': {
      const params = new URLSearchParams({ dslevel: args.dslevel });
      setIf(params, 'volser', args.volser);
      setIf(params, 'start', args.start);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      return textResult(await mvsmfFetch(`/zosmf/restfiles/ds?${params}`, { headers }));
    }

    case 'createDataset': {
      const body = {};
      for (const k of ['like', 'dsorg', 'recfm', 'lrecl', 'blksize', 'primary', 'secondary', 'dirblk', 'alcunit']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return textResult(
        await mvsmfFetch(dsPath(args.dsname), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    case 'deleteDataset':
      return textResult(await mvsmfFetch(dsPath(args.dsname), { method: 'DELETE' }));

    case 'readDataset':
      return readDatasetLike(dsPath(args.dsname), args.dsname, args);

    case 'writeDataset':
      return writeDatasetLike(dsPath(args.dsname), args.dsname, args);

    case 'listMembers': {
      const params = new URLSearchParams();
      setIf(params, 'pattern', args.pattern);
      setIf(params, 'start', args.start);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      const qs = params.toString();
      return textResult(await mvsmfFetch(`${dsPath(args.dsname)}/member${qs ? `?${qs}` : ''}`, { headers }));
    }

    case 'readMember':
      return readDatasetLike(dsPath(args.dsname, args.member), args.dsname, args);

    case 'writeMember':
      return writeDatasetLike(dsPath(args.dsname, args.member), args.dsname, args);

    case 'deleteMember':
      return textResult(await mvsmfFetch(dsPath(args.dsname, args.member), { method: 'DELETE' }));

    // --- USS ---
    case 'listUssFiles': {
      const params = new URLSearchParams({ path: args.path });
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      return textResult(await mvsmfFetch(`/zosmf/restfiles/fs?${params}`, { headers }));
    }

    case 'readUssFile':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          headers: readHeaders(args),
          binary: args.dataType === 'binary',
        })
      );

    case 'writeUssFile': {
      if (args.encoding) throw new Error('encoding is only supported for data sets; USS files have no LRECL.');
      const { body, dataType } = await writeBody(args);
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'PUT',
          headers: writeHeaders(args, dataType),
          body,
        })
      );
    }

    case 'createUssFile':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: args.isDirectory ? 'directory' : 'file',
            ...(args.mode ? { mode: args.mode } : {}),
          }),
        })
      );

    case 'deleteUssFile':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'DELETE',
          headers: args.recursive ? { 'X-IBM-Option': 'recursive' } : {},
        })
      );

    // --- Jobs ---
    case 'listJobs': {
      const params = new URLSearchParams();
      for (const k of ['owner', 'prefix', 'jobid', 'status']) setIf(params, k, args[k]);
      setIf(params, 'max-jobs', args.maxJobs);
      if (args.execData) params.set('exec-data', 'Y');
      const qs = params.toString();
      return textResult(await mvsmfFetch(`/zosmf/restjobs/jobs${qs ? `?${qs}` : ''}`));
    }

    case 'getJobStatus':
      return textResult(await mvsmfFetch(`${jobPath(args.jobname, args.jobid)}${args.execData ? '?exec-data=Y' : ''}`));

    case 'listJobFiles':
      return textResult(await mvsmfFetch(`${jobPath(args.jobname, args.jobid)}/files`));

    case 'readJobFile':
      return textResult(await mvsmfFetch(`${jobPath(args.jobname, args.jobid)}/files/${enc(args.ddid)}/records`));

    case 'submitJob':
      return textResult(
        await mvsmfFetch('/zosmf/restjobs/jobs', {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: args.jcl,
        })
      );

    case 'submitJobFromDataset': {
      // mvsMF's submit_file() accepts exactly the //'DSN(MEM)' form.
      const bare = args.dsname.trim().replace(/^\/\//, '').replace(/^'|'$/g, '');
      return textResult(
        await mvsmfFetch('/zosmf/restjobs/jobs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: `//'${bare}'` }),
        })
      );
    }

    case 'purgeJob':
      return textResult(await mvsmfFetch(jobPath(args.jobname, args.jobid), { method: 'DELETE' }));

    // --- Console services ---
    case 'issueConsoleCommand': {
      const body = { cmd: args.cmd };
      if (args.async) body.async = 'Y';
      if (args.solKey) body['sol-key'] = args.solKey;
      if (args.unsolKey) body['unsol-key'] = args.unsolKey;
      if (args.unsolDetectSync) body['unsol-detect-sync'] = 'Y';
      if (args.unsolDetectTimeout !== undefined) body['unsol-detect-timeout'] = String(args.unsolDetectTimeout);
      if (args.detectTime !== undefined) body['detect-time'] = String(args.detectTime);
      return textResult(
        await mvsmfFetch(consolePath(args.consoleName), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    case 'getConsoleMessages':
      return textResult(await mvsmfFetch(`${consolePath(args.consoleName)}/solmsgs/${enc(args.key)}`));

    case 'getConsoleDetections':
      return textResult(await mvsmfFetch(`${consolePath(args.consoleName)}/detections/${enc(args.key)}`));

    case 'getHardcopyLog': {
      const params = new URLSearchParams();
      for (const k of ['timeRange', 'time', 'timestamp', 'direction', 'hardcopy', 'sysName']) setIf(params, k, args[k]);
      const qs = params.toString();
      return textResult(await mvsmfFetch(`/zosmf/restconsoles/v1/log${qs ? `?${qs}` : ''}`));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mvsmf-mcp-bridge', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, args || {});
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`mvsmf-mcp-bridge connected (base=${BASE_URL}, user=${USER || '(none)'})`);
