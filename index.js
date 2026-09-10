#!/usr/bin/env node
// MCP server for the z/OSMF REST API. Speaks MCP over stdio; each tool call is
// translated into one z/OSMF REST call using Basic Auth.
//
// Two backends are supported, selected with ZOSMF_MODE:
//   zosmf  (default) a real IBM z/OSMF instance; the full tool set is exposed.
//   mvsmf            mvsMF (https://github.com/mvslovers/mvsmf), the z/OSMF-
//                    compatible API for MVS 3.8j. Tools and options mvsMF does
//                    not implement are removed from tools/list and refused if
//                    called anyway.
//
// Config (env vars; the MVSMF_* names from earlier releases are still read):
//   ZOSMF_BASE_URL       e.g. https://zosmf.example.com:443 or http://127.0.0.1:8090
//   ZOSMF_USER           userid
//   ZOSMF_PASSWORD       password
//   ZOSMF_MODE           zosmf | mvsmf   (defaults to mvsmf when only MVSMF_* vars are set)
//   ZOSMF_INSECURE_TLS   true  -> accept self-signed z/OSMF certificates
//                        (for a CA bundle use NODE_EXTRA_CA_CERTS instead)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const env = process.env;
const legacyEnv = Boolean(env.MVSMF_BASE_URL || env.MVSMF_USER || env.MVSMF_PASSWORD);
const BASE_URL = (env.ZOSMF_BASE_URL || env.MVSMF_BASE_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
const USER = env.ZOSMF_USER || env.MVSMF_USER;
const PASSWORD = env.ZOSMF_PASSWORD || env.MVSMF_PASSWORD;
const MODE = (env.ZOSMF_MODE || (legacyEnv && !env.ZOSMF_BASE_URL ? 'mvsmf' : 'zosmf')).toLowerCase();
if (MODE !== 'zosmf' && MODE !== 'mvsmf') {
  console.error(`ZOSMF_MODE must be "zosmf" or "mvsmf" (got "${env.ZOSMF_MODE}")`);
  process.exit(2);
}
const MVSMF = MODE === 'mvsmf';
if (/^(1|true|yes)$/i.test(env.ZOSMF_INSECURE_TLS || '')) {
  // Node's fetch reads this at connect time; the process talks to one host only.
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function authHeader() {
  if (!USER || !PASSWORD) return {};
  const b64 = Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${b64}` };
}

// Response headers minus the session cookie: z/OSMF and mvsMF answer every
// Basic request with a Set-Cookie: LtpaToken2=... and there is no reason to
// echo a bearer credential into the model transcript.
function responseHeaders(res) {
  const h = Object.fromEntries(res.headers);
  delete h['set-cookie'];
  return h;
}

// binary: true  -> body returned as base64 in `bodyBase64` (plus `byteLength`);
//                  falls back to text/JSON parsing on non-2xx so error bodies
//                  stay readable.
async function zosmfFetch(path, { method = 'GET', headers = {}, body, binary = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    // z/OSMF rejects any request without X-CSRF-ZOSMF-HEADER; mvsMF ignores it.
    headers: { 'X-CSRF-ZOSMF-HEADER': 'zosmf-mcp', ...authHeader(), ...headers },
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

// volser selects the -(volser) uncataloged form; z/OSMF only (mvsMF answers 404).
function dsPath(dsname, member, volser) {
  const vol = volser ? `-(${enc(volser)})/` : '';
  return `/zosmf/restfiles/ds/${vol}${enc(dsname)}${member ? `(${enc(member)})` : ''}`;
}

function jobPath(jobname, jobid) {
  return `/zosmf/restjobs/jobs/${enc(jobname)}/${enc(jobid)}`;
}

function jsonBody(method, obj, extraHeaders = {}) {
  return { method, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(obj) };
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
  // z/OSMF lists names only unless asked for base attributes; mvsMF always sends them.
  const headers = MVSMF ? {} : { 'X-IBM-Attributes': 'base' };
  const r = await zosmfFetch(`/zosmf/restfiles/ds?${new URLSearchParams({ dslevel: want })}`, { headers });
  const item = r.ok && Array.isArray(r.body?.items) ? r.body.items.find((i) => i.dsname === want) : undefined;
  if (!item) throw new Error(`Cannot read attributes of ${want} from the catalog (list status ${r.status})`);
  // Both servers emit lrecl/blksize as strings (z/OSMF names the latter blksz).
  return { ...item, lrecl: Number(item.lrecl) || 0, blksize: Number(item.blksize ?? item.blksz) || 0 };
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

// X-IBM-Data-Type value for a transfer, or undefined for the server default.
// fileEncoding (z/OSMF only) rides on text mode: "text;fileEncoding=IBM-1047".
function dataTypeHeader(dataType, fileEncoding) {
  const dt = dataType || 'text';
  if (fileEncoding) {
    if (dt !== 'text') throw new Error('fileEncoding applies to text transfers only; do not combine it with dataType binary/record.');
    return `text;fileEncoding=${fileEncoding}`;
  }
  return dt === 'text' ? undefined : dt;
}

function readHeaders(args) {
  const h = {};
  const dt = dataTypeHeader(args.dataType, args.fileEncoding);
  if (dt) h['X-IBM-Data-Type'] = dt;
  if (args.recordRange) h['X-IBM-Record-Range'] = args.recordRange;
  if (args.migratedRecall) h['X-IBM-Migrated-Recall'] = args.migratedRecall;
  if (args.returnEtag) h['X-IBM-Return-Etag'] = 'true';
  if (args.ifNoneMatch) h['If-None-Match'] = args.ifNoneMatch;
  return h;
}

function writeHeaders(args, dataType) {
  const h = { 'Content-Type': dataType === 'text' ? 'text/plain' : 'application/octet-stream' };
  const dt = dataTypeHeader(dataType, args.fileEncoding);
  if (dt) h['X-IBM-Data-Type'] = dt;
  if (args.migratedRecall) h['X-IBM-Migrated-Recall'] = args.migratedRecall;
  if (args.returnEtag) h['X-IBM-Return-Etag'] = 'true';
  if (args.ifMatch) h['If-Match'] = args.ifMatch;
  return h;
}

// Resolve the body for a write from content / contentBase64 / encoding.
// Returns { body, dataType } where dataType is 'text', 'binary' or 'record'.
async function writeBody(args, dsname) {
  if (args.encoding) {
    if (args.content === undefined) throw new Error('encoding requires `content` (text).');
    if (args.contentBase64 !== undefined) throw new Error('encoding and contentBase64 are mutually exclusive.');
    if (args.fileEncoding) throw new Error('encoding (local translation) and fileEncoding (server translation) are mutually exclusive.');
    const { recfm, lrecl } = await datasetAttrs(dsname);
    requireFixed(recfm, lrecl, `encoding=${args.encoding}`);
    return { body: encodeRecords(args.content, args.encoding, lrecl), dataType: 'binary' };
  }
  if (args.contentBase64 !== undefined) {
    if (args.content !== undefined) throw new Error('content and contentBase64 are mutually exclusive.');
    return { body: Buffer.from(args.contentBase64, 'base64'), dataType: args.dataType === 'record' ? 'record' : 'binary' };
  }
  if (args.content !== undefined) {
    if (args.dataType === 'record') throw new Error('dataType "record" needs length-prefixed bytes; pass them as contentBase64.');
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
    if (args.fileEncoding) throw new Error('encoding (local translation) and fileEncoding (server translation) are mutually exclusive.');
    const r = await zosmfFetch(path, { headers: readHeaders({ ...args, dataType: 'binary' }), binary: true });
    if (!r.ok || r.bodyBase64 === undefined) return textResult(r);
    const { recfm, lrecl } = await datasetAttrs(dsname);
    requireFixed(recfm, lrecl, `encoding=${args.encoding}`);
    const buf = Buffer.from(r.bodyBase64, 'base64');
    const { bodyBase64, byteLength, ...rest } = r;
    return textResult({ ...rest, encoding: args.encoding, lrecl, recfm, byteLength, body: decodeRecords(buf, args.encoding, lrecl) });
  }
  const binary = args.dataType === 'binary' || args.dataType === 'record';
  return textResult(await zosmfFetch(path, { headers: readHeaders(args), binary }));
}

async function writeDatasetLike(path, dsname, args) {
  const { body, dataType } = await writeBody(args, dsname);
  return textResult(await zosmfFetch(path, { method: 'PUT', headers: writeHeaders(args, dataType), body }));
}

// ---------------------------------------------------------------------------
// Tool schemas
//
// Every tool and option below is defined for z/OSMF. Ones mvsMF does not
// implement are tagged with zo() / ZOSMF_ONLY and dropped from the schema
// in mvsmf mode; callArgs() then refuses them if a client sends them anyway.
// ---------------------------------------------------------------------------

const ZOSMF_ONLY = Symbol('zosmfOnly');
const zo = (prop) => ({ ...prop, [ZOSMF_ONLY]: true });
// Enum values to remove in mvsmf mode; the rest of the property stays.
const MVSMF_DROP = Symbol('mvsmfDropEnum');
const zoEnum = (prop, values) => ({ ...prop, [MVSMF_DROP]: values });

const DS_VOLSER = zo({ type: 'string', description: 'Volume serial for an uncataloged data set (the -(volser) route).' });

const FILE_ENCODING = zo({
  type: 'string',
  description: 'Server-side code page for text mode (X-IBM-Data-Type: text;fileEncoding=…), e.g. "IBM-1047", "IBM-037". Mutually exclusive with dataType binary/record and with encoding.',
});

const MIGRATED_RECALL = zo({
  type: 'string',
  enum: ['wait', 'nowait', 'error'],
  description: 'What to do if the data set is migrated (X-IBM-Migrated-Recall). Default wait.',
});

const DS_READ_OPTS = {
  dataType: {
    type: 'string',
    enum: ['text', 'binary', 'record'],
    description:
      'Transfer mode (X-IBM-Data-Type). text (default): server EBCDIC->ASCII conversion, body returned as text. binary: raw bytes, returned as bodyBase64. record: like binary with a 4-byte big-endian length before each record, returned as bodyBase64.',
  },
  fileEncoding: FILE_ENCODING,
  encoding: {
    type: 'string',
    enum: ['cp037', 'cp1047'],
    description:
      "Fetch in binary and translate locally with this EBCDIC code page instead of the server's text conversion (RECFM F/FB only). Needed on mvsMF, whose text mode has one fixed table that puts [ ] ^ at the IBM-037 positions; on z/OSMF prefer fileEncoding. Mutually exclusive with dataType and fileEncoding.",
  },
  recordRange: zo({ type: 'string', description: 'Subset of records to read (X-IBM-Record-Range): "start-end" (0-based, inclusive) or "start,count".' }),
  migratedRecall: MIGRATED_RECALL,
  returnEtag: { type: 'boolean', description: 'Ask for an ETag (X-IBM-Return-Etag) to use as ifMatch on a later write.' },
  ifNoneMatch: { type: 'string', description: 'Conditional read: an ETag from an earlier read. Answers 304 with no body if unchanged.' },
};

const DS_WRITE_OPTS = {
  content: { type: 'string', description: 'Text content to write. Records are split at newlines.' },
  contentBase64: { type: 'string', description: 'Raw bytes (base64) to write in binary or record mode. Mutually exclusive with content.' },
  dataType: zoEnum(
    {
      type: 'string',
      enum: ['text', 'binary', 'record'],
      description:
        'Transfer mode for the body. text (default): server ASCII->EBCDIC conversion. binary: bytes stored as-is, split at LRECL. record: contentBase64 carries a 4-byte big-endian length before each record (z/OSMF only; mvsMF accepts the header but stores garbage).',
    },
    ['record']
  ),
  fileEncoding: FILE_ENCODING,
  encoding: {
    type: 'string',
    enum: ['cp037', 'cp1047'],
    description:
      "Translate `content` locally with this EBCDIC code page, pad each line to LRECL and write in binary, bypassing the server's text conversion (RECFM F/FB only; lines longer than LRECL are rejected before anything is written). Needed on mvsMF so [ ] ^ land where JCC and other 1047-expecting tools want them; on z/OSMF prefer fileEncoding.",
  },
  migratedRecall: MIGRATED_RECALL,
  ifMatch: { type: 'string', description: 'Optimistic lock: an ETag from an earlier read (or "*" = must exist). The write is refused with 412 if the target changed.' },
  returnEtag: { type: 'boolean', description: 'Return the ETag of the target as it stands after the write (needed for the next ifMatch).' },
};

const USS_READ_OPTS = {
  dataType: { type: 'string', enum: ['text', 'binary'], description: 'text (default): server EBCDIC->ASCII conversion. binary: raw bytes returned as bodyBase64.' },
  fileEncoding: FILE_ENCODING,
  recordRange: DS_READ_OPTS.recordRange,
  returnEtag: DS_READ_OPTS.returnEtag,
  ifNoneMatch: DS_READ_OPTS.ifNoneMatch,
};

const USS_WRITE_OPTS = {
  content: { type: 'string', description: 'Text content to write.' },
  contentBase64: DS_WRITE_OPTS.contentBase64,
  dataType: { type: 'string', enum: ['text', 'binary'], description: 'Transfer mode for `content`. contentBase64 always implies binary.' },
  fileEncoding: FILE_ENCODING,
  ifMatch: DS_WRITE_OPTS.ifMatch,
  returnEtag: DS_WRITE_OPTS.returnEtag,
};

const JOB_MODIFY_OPTS = {
  jobname: { type: 'string' },
  jobid: { type: 'string' },
  synchronous: {
    type: 'boolean',
    description: 'X-IBM-Job-Modify-Version 2.0: wait for JES to complete the request and return its outcome (default true). false = 1.0, queue it and return 202.',
  },
};

const ALL_TOOLS = [
  {
    name: 'zosmfInfo',
    description:
      'Get z/OSMF system information (GET /zosmf/info): z/OS and z/OSMF versions, hostname, plugins. Requires valid credentials on both z/OSMF and mvsMF.',
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
        attributes: zo({
          type: 'string',
          enum: ['dsname', 'base', 'vol'],
          description: 'X-IBM-Attributes: dsname = names only, base (default here) = DCB/space attributes, vol = names plus volume. z/OSMF itself defaults to dsname.',
        }),
      },
      required: ['dslevel'],
      additionalProperties: false,
    },
  },
  {
    name: 'createDataset',
    description:
      'Allocate a new sequential (PS) or partitioned (PO) data set (POST /zosmf/restfiles/ds/{name}). Either give dsorg/recfm/lrecl/blksize/primary explicitly, or `like` an existing data set and override any of them. Caution: allocates real DASD space. On mvsMF every allocation failure (name exists, no space, not authorized) answers 500 "Dynamic allocation Error".',
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
        dsntype: zo({ type: 'string', enum: ['LIBRARY', 'PDS', 'LARGE', 'BASIC', 'EXTREQ', 'EXTPREF', 'HFS'], description: 'Data set type; LIBRARY = PDS/E.' }),
        volser: zo({ type: 'string', description: 'Volume to allocate on' }),
        unit: zo({ type: 'string', description: 'Device type / esoteric, e.g. "3390", "SYSDA"' }),
        avgblk: zo({ type: 'integer', description: 'Average block length for alcunit BLK' }),
        storclass: zo({ type: 'string', description: 'SMS storage class' }),
        mgntclass: zo({ type: 'string', description: 'SMS management class' }),
        dataclass: zo({ type: 'string', description: 'SMS data class' }),
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
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' }, volser: DS_VOLSER },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'readDataset',
    description:
      'Read the content of a sequential (PS) data set (GET /zosmf/restfiles/ds/{name}). PDS data sets return 400; use readMember instead. Supports text/binary/record transfer, server or local code-page selection, record ranges, and ETag conditional reads.',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' }, volser: DS_VOLSER, ...DS_READ_OPTS },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeDataset',
    description:
      'Write/overwrite the content of a sequential (PS) data set (PUT /zosmf/restfiles/ds/{name}). Caution: replaces the existing content of a real data set; an empty body truncates it. The data set must already exist (see createDataset).',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' }, volser: DS_VOLSER, ...DS_WRITE_OPTS },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'renameDataset',
    description:
      'Rename a data set, or a member within a PDS (PUT /zosmf/restfiles/ds/{new} with a {"request":"rename"} body). Give `member` and `newMember` to rename a member (dsname stays the same); otherwise the whole data set is renamed to `newDsname`. Caution: JCL and catalog references to the old name break.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Current data set name' },
        newDsname: { type: 'string', description: 'New data set name (data set rename)' },
        member: { type: 'string', description: 'Current member name (member rename)' },
        newMember: { type: 'string', description: 'New member name (member rename)' },
        enq: zo({ type: 'string', enum: ['EXCL', 'SHRW'], description: 'Serialization on the source (default EXCL).' }),
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'copyDataset',
    description:
      'Copy a sequential data set or a PDS member to another data set/member (PUT /zosmf/restfiles/ds/{target} with a {"request":"copy"} body). Omit fromMember/toMember to copy a whole sequential data set; give fromMember "*" to copy all members of a PDS. Caution: replace=true overwrites the target.',
    inputSchema: {
      type: 'object',
      properties: {
        fromDsname: { type: 'string', description: 'Source data set' },
        fromMember: { type: 'string', description: 'Source member, or "*" for all members' },
        toDsname: { type: 'string', description: 'Target data set (must exist)' },
        toMember: { type: 'string', description: 'Target member' },
        fromVolser: { type: 'string', description: 'Source volume, for an uncataloged source' },
        alias: { type: 'boolean', description: 'Also copy member aliases (default false)' },
        replace: { type: 'boolean', description: 'Overwrite existing target members (default false)' },
        enq: { type: 'string', enum: ['SHR', 'SHRW', 'EXCLU'], description: 'Serialization on the source (default SHR).' },
      },
      required: ['fromDsname', 'toDsname'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'hsmRequest',
    description:
      'Issue a DFSMShsm request against a data set (PUT /zosmf/restfiles/ds/{name}): hrecall brings a migrated data set back, hmigrate migrates it, hdelete deletes the migrated copy. Caution: hdelete destroys data; hmigrate makes the next access slow.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Fully qualified data set name' },
        request: { type: 'string', enum: ['hrecall', 'hmigrate', 'hdelete'] },
        wait: { type: 'boolean', description: 'Wait for HSM to finish before answering (default false)' },
        purge: { type: 'boolean', description: 'hdelete only: also purge the data set from the HSM backup/migration control data (default false)' },
      },
      required: ['dsname', 'request'],
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
        volser: DS_VOLSER,
        pattern: { type: 'string', description: 'Member name filter: * matches any run of characters, % exactly one; e.g. "JES2*", "IEF%%%01"' },
        start: { type: 'string', description: 'Starting member name for pagination (inclusive, EBCDIC collation)' },
        maxItems: { type: 'integer', description: 'Max members to return (X-IBM-Max-Items), 0/omitted = all' },
        attributes: zo({ type: 'string', enum: ['member', 'base'], description: 'X-IBM-Attributes: member = names only (default), base = ISPF statistics (vers, mod, created, changed, user…) too.' }),
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'readMember',
    description:
      'Read a single PDS member (GET /zosmf/restfiles/ds/{name}({member})). Supports text/binary/record transfer, server or local code-page selection (encoding=cp1047 on mvsMF for JCC-style source with real brackets), record ranges, and ETag conditional reads.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
        volser: DS_VOLSER,
        ...DS_READ_OPTS,
      },
      required: ['dsname', 'member'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeMember',
    description:
      'Write/overwrite a single PDS member (PUT /zosmf/restfiles/ds/{name}({member})), creating it if absent. Caution: replaces the existing content of a real PDS member; an empty body truncates it. Use ifMatch to avoid clobbering a concurrent edit.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
        volser: DS_VOLSER,
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
        volser: DS_VOLSER,
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
        name: zo({ type: 'string', description: 'Only entries whose name matches this pattern (shell wildcards)' }),
        depth: zo({ type: 'integer', description: 'How many directory levels to descend (default 1)' }),
        type: zo({ type: 'string', enum: ['f', 'd', 'l', 'c', 'b', 'p', 's'], description: 'Only entries of this type (file, directory, symlink, …)' }),
        filesys: zo({ type: 'string', enum: ['all', 'same'], description: 'Whether to cross mount points (default same)' }),
        symlinks: zo({ type: 'string', enum: ['follow', 'report'], description: 'Follow symlinks or report them as-is' }),
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'readUssFile',
    description: 'Read the content of a USS file (GET /zosmf/restfiles/fs/{filepath}). On mvsMF (UFSD) files are capped at 64 KB.',
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
      'Write/overwrite the content of a USS file (PUT /zosmf/restfiles/fs/{filepath}), creating it if absent. Caution: replaces the existing content of a real file. On mvsMF (UFSD) files are capped at 64 KB.',
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
      'Create a new USS file or directory (POST /zosmf/restfiles/fs/{filepath}). Caution: creates real filesystem entries. Fails with 400 if the path already exists.',
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
      'Delete a USS file or directory (DELETE /zosmf/restfiles/fs/{filepath}). Caution: irreversibly removes a real file or directory.',
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
  {
    zosmfOnly: true,
    name: 'chmodUssFile',
    description: 'Change the permissions of a USS file or directory (PUT /zosmf/restfiles/fs/{filepath}, {"request":"chmod"}).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path' },
        mode: { type: 'string', description: 'Octal ("755") or symbolic ("u+x,go-w") mode' },
        recursive: { type: 'boolean', description: 'Apply to a directory tree (default false)' },
        links: { type: 'string', enum: ['follow', 'suppress'], description: 'Follow symlinks or leave them alone (default follow)' },
      },
      required: ['path', 'mode'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'chownUssFile',
    description: 'Change the owner and/or group of a USS file or directory (PUT /zosmf/restfiles/fs/{filepath}, {"request":"chown"}).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path' },
        owner: { type: 'string', description: 'New owner (user id or UID)' },
        group: { type: 'string', description: 'New group (name or GID)' },
        recursive: { type: 'boolean', description: 'Apply to a directory tree (default false)' },
        links: { type: 'string', enum: ['follow', 'suppress', 'change'], description: 'Symlink handling (default follow)' },
      },
      required: ['path', 'owner'],
      additionalProperties: false,
    },
  },
  {
    name: 'chtagUssFile',
    description:
      'List, set or remove the file tag (code page) of a USS file (PUT /zosmf/restfiles/fs/{filepath}, {"request":"chtag"}). mvsMF has no file tagging: list reports untagged and set/remove are accepted as no-ops.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path' },
        action: { type: 'string', enum: ['list', 'set', 'remove'] },
        type: zo({ type: 'string', enum: ['binary', 'text', 'mixed'], description: 'set only: tag type (default mixed)' }),
        codeset: zo({ type: 'string', description: 'set only: code set, e.g. "IBM-1047", "ISO8859-1"' }),
        recursive: zo({ type: 'boolean', description: 'Apply to a directory tree (default false)' }),
        links: zo({ type: 'string', enum: ['follow', 'suppress', 'change'], description: 'Symlink handling (default follow)' }),
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'moveUssFile',
    description: 'Move or rename a USS file or directory (PUT /zosmf/restfiles/fs/{to}, {"request":"move","from":…}). Caution: overwrite=true replaces an existing target.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current absolute USS path' },
        to: { type: 'string', description: 'New absolute USS path' },
        overwrite: { type: 'boolean', description: 'Replace an existing target (default false)' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'copyUssFile',
    description: 'Copy a USS file or directory (PUT /zosmf/restfiles/fs/{to}, {"request":"copy","from":…}). Caution: overwrite=true replaces an existing target.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source absolute USS path' },
        to: { type: 'string', description: 'Target absolute USS path' },
        overwrite: { type: 'boolean', description: 'Replace an existing target (default false)' },
        recursive: { type: 'boolean', description: 'Copy a directory tree (default false)' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },

  // --- Jobs ---
  {
    name: 'listJobs',
    description: 'List JES jobs (GET /zosmf/restjobs/jobs). Owner defaults to the authenticated user; pass owner "*" for everyone.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Job owner filter, "*" for all owners' },
        prefix: { type: 'string', description: 'Job name prefix filter, "*" for all' },
        jobid: { type: 'string', description: 'Specific job id filter' },
        status: { type: 'string', description: 'INPUT|ACTIVE|OUTPUT|* (also XMIT/SETUP/RECEIVE/UNKNOWN on MVS 3.8j)' },
        maxJobs: { type: 'integer', description: 'Max jobs returned, 1-1000 (default 1000)' },
        execData: { type: 'boolean', description: 'Include exec-started / exec-ended timestamps (UTC)' },
        userCorrelator: zo({ type: 'string', description: 'Only jobs submitted with this user correlator (X-IBM-User-Correlator)' }),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getJobStatus',
    description:
      "Get a job's status (GET /zosmf/restjobs/jobs/{jobname}/{jobid}). retcode is null until the job finishes (on mvsMF: always null without the SYZJ201 usermod).",
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
        execData: { type: 'boolean', description: 'Include exec-started / exec-ended timestamps (UTC)' },
        stepData: zo({ type: 'boolean', description: 'Include per-step completion codes (step-data=Y)' }),
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
      'Read the record content of one job spool file (GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records). On mvsMF a 404 with reason 10 means JES2 already purged that spool output.',
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
        ddid: { type: 'string', description: 'Spool file id (ddid) from listJobFiles' },
        recordRange: zo({ type: 'string', description: 'Subset of records (X-IBM-Record-Range): "start-end" or "start,count".' }),
        fileEncoding: FILE_ENCODING,
      },
      required: ['jobname', 'jobid', 'ddid'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'getJobJcl',
    description: 'Retrieve the JCL a job was submitted with (GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/JCL/records).',
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
    name: 'submitJob',
    description:
      'Submit a job by inline JCL text (PUT /zosmf/restjobs/jobs, Content-Type: text/plain). Use with care: this executes real batch work. On mvsMF the server appends USER=/PASSWORD= (and NOTIFY=$MVSMF if the card has none) to the JOB statement, and the JOB statement needs a programmer name or MVS flushes it with a JCL ERROR.',
    inputSchema: {
      type: 'object',
      properties: {
        jcl: { type: 'string', description: 'Full inline JCL text, including the JOB card' },
        intrdrClass: zo({ type: 'string', description: 'Internal reader class (X-IBM-Intrdr-Class), one character' }),
        intrdrRecfm: zo({ type: 'string', enum: ['F', 'V'], description: 'Record format of the JCL (X-IBM-Intrdr-Recfm), default F' }),
        intrdrLrecl: zo({ type: 'integer', description: 'Record length of the JCL (X-IBM-Intrdr-Lrecl), default 80' }),
        symbols: zo({
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'JCL symbols to substitute (X-IBM-JCL-Symbol-<name>), e.g. {"HLQ":"USER1"}. Names max 8 chars.',
        }),
        notificationUrl: zo({ type: 'string', description: 'URL z/OSMF calls back when the job ends (X-IBM-Notification-URL)' }),
      },
      required: ['jcl'],
      additionalProperties: false,
    },
  },
  {
    name: 'submitJobFromDataset',
    description:
      'Submit a job whose JCL is in a data set or PDS member (PUT /zosmf/restjobs/jobs, Content-Type: application/json). Use with care: this executes real batch work. The JCL bytes are read from DASD as stored, so source written with encoding=cp1047 keeps its code points.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Data set holding the JCL, e.g. "HERC01.JCL(MYJOB)" or "HERC01.JOB.JCL"' },
        intrdrClass: zo({ type: 'string', description: 'Internal reader class (X-IBM-Intrdr-Class), one character' }),
        symbols: zo({ type: 'object', additionalProperties: { type: 'string' }, description: 'JCL symbols to substitute (X-IBM-JCL-Symbol-<name>)' }),
        notificationUrl: zo({ type: 'string', description: 'URL z/OSMF calls back when the job ends (X-IBM-Notification-URL)' }),
      },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'submitJobFromUssFile',
    description: 'Submit a job whose JCL is in a USS file (PUT /zosmf/restjobs/jobs, {"file":"/u/…"}). Use with care: this executes real batch work.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS path of the JCL file' },
        intrdrClass: { type: 'string', description: 'Internal reader class (X-IBM-Intrdr-Class), one character' },
        symbols: { type: 'object', additionalProperties: { type: 'string' }, description: 'JCL symbols to substitute (X-IBM-JCL-Symbol-<name>)' },
        notificationUrl: { type: 'string', description: 'URL z/OSMF calls back when the job ends (X-IBM-Notification-URL)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'purgeJob',
    description:
      'Purge/cancel a job from JES (DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}). Caution: removes a job from the queue, including an active one; irreversible. On mvsMF started tasks and TSO users are refused with 400.',
    inputSchema: {
      type: 'object',
      properties: {
        jobname: { type: 'string' },
        jobid: { type: 'string' },
        synchronous: zo(JOB_MODIFY_OPTS.synchronous),
      },
      required: ['jobname', 'jobid'],
      additionalProperties: false,
    },
  },
  {
    zosmfOnly: true,
    name: 'cancelJob',
    description: 'Cancel a running job but keep its output (PUT /zosmf/restjobs/jobs/{jobname}/{jobid}, {"request":"cancel"}). Caution: stops real work.',
    inputSchema: { type: 'object', properties: JOB_MODIFY_OPTS, required: ['jobname', 'jobid'], additionalProperties: false },
  },
  {
    zosmfOnly: true,
    name: 'holdJob',
    description: 'Hold a job in the input queue (PUT /zosmf/restjobs/jobs/{jobname}/{jobid}, {"request":"hold"}).',
    inputSchema: { type: 'object', properties: JOB_MODIFY_OPTS, required: ['jobname', 'jobid'], additionalProperties: false },
  },
  {
    zosmfOnly: true,
    name: 'releaseJob',
    description: 'Release a held job (PUT /zosmf/restjobs/jobs/{jobname}/{jobid}, {"request":"release"}).',
    inputSchema: { type: 'object', properties: JOB_MODIFY_OPTS, required: ['jobname', 'jobid'], additionalProperties: false },
  },
  {
    zosmfOnly: true,
    name: 'changeJobClass',
    description: 'Change the execution class of a queued job (PUT /zosmf/restjobs/jobs/{jobname}/{jobid}, {"class":"X"}).',
    inputSchema: {
      type: 'object',
      properties: { ...JOB_MODIFY_OPTS, class: { type: 'string', description: 'New job class, one character' } },
      required: ['jobname', 'jobid', 'class'],
      additionalProperties: false,
    },
  },

  // --- Console services ---
  {
    name: 'issueConsoleCommand',
    description:
      'Issue an MVS operator command (PUT /zosmf/restconsoles/consoles/{consoleName}). Caution: operator commands can affect the whole system (start/stop subsystems, cancel jobs, etc); mvsMF applies no per-command authorization. Returns cmd-response (what arrived before the reply went quiet) plus a cmd-response-key for getConsoleMessages; with unsolKey also a detection-key for getConsoleDetections. On mvsMF a 429 or 503/8/17 means the command was NOT issued and may be retried; 503/8/15 means it WAS issued but the response was lost.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Operator command text, max 126 chars, e.g. "D T" or "D A,L"' },
        consoleName: { type: 'string', description: 'Console name, 2-8 chars. Default "defcn".' },
        async: { type: 'boolean', description: 'Return only the response key, not cmd-response.' },
        solKey: { type: 'string', description: 'Substring to look for in the solicited response; sets sol-key-detected in the result.' },
        unsolKey: { type: 'string', description: 'Arm detection of an unsolicited message containing this substring (e.g. "FTPD054I" after "S FTPD"). Returns a detection-key.' },
        unsolDetectSync: { type: 'boolean', description: 'With unsolKey: block up to unsolDetectTimeout and return status/msg inline instead of a detection-key.' },
        unsolDetectTimeout: { type: 'integer', description: 'Seconds to block in sync detection (default 20, max 60).' },
        detectTime: { type: 'integer', description: 'Seconds the async detection stays armed (default 30).' },
        system: zo({ type: 'string', description: 'Sysplex member to route the command to (default: the local system)' }),
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'getConsoleMessages',
    description:
      'Collect response lines that arrived after issueConsoleCommand returned (GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}). Each call returns only new lines; "" means nothing new (or the key aged out).',
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
      'Poll an unsolicited-message detection armed by issueConsoleCommand with unsolKey (GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}). status is waiting, detected (msg holds the message) or expired.',
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
      'Retrieve hardcopy log (SYSLOG / OPERLOG) messages over a time window (GET /zosmf/restconsoles/v1/log). Default: the last 10 minutes ending now. Items are oldest-first; nextTimestamp is the far edge of the window for paging.',
    inputSchema: {
      type: 'object',
      properties: {
        timeRange: { type: 'string', description: 'Window size: 1-999 followed by s, m or h, e.g. "2m", "1h". Default "10m".' },
        time: { type: 'string', description: 'ISO 8601 UTC anchor, e.g. "2026-06-30T02:00:00Z". Default now.' },
        timestamp: { type: 'integer', description: 'UNIX millisecond anchor; overrides time. Use a previous nextTimestamp to page.' },
        direction: { type: 'string', enum: ['backward', 'forward'], description: 'Direction from the anchor. Default backward.' },
        hardcopy: { type: 'string', enum: ['syslog', 'operlog'], description: 'Log source; on mvsMF operlog falls back to SYSLOG.' },
        sysName: { type: 'string', description: 'System name, max 8 chars.' },
      },
      additionalProperties: false,
    },
  },

  // --- TSO ---
  {
    zosmfOnly: true,
    name: 'issueTsoCommand',
    description:
      'Run one TSO/E command in a fresh address space and return its output (PUT /zosmf/tsoApp/v1/tso, stateless). Needs z/OSMF 2.4 or later with the TSO/E address space services enabled. Caution: runs a real TSO command under your userid.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'TSO command text, e.g. "LISTCAT LEVEL(USER1)"' },
        account: { type: 'string', description: 'Accounting information for the address space (acct), if your site requires one' },
        proc: { type: 'string', description: 'Logon procedure (default IZUFPROC)' },
        regionSize: { type: 'integer', description: 'Region size in KB (default 4096)' },
        characterSet: { type: 'string', description: 'Character set (default 697)' },
        codePage: { type: 'string', description: 'Code page (default 1047)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

// Build the tool list for the active mode: drop z/OSMF-only tools, drop
// z/OSMF-only properties, trim enums mvsMF cannot honor, and strip the markers.
function toolsForMode(mvsmf) {
  const out = [];
  for (const { zosmfOnly, ...tool } of ALL_TOOLS) {
    if (mvsmf && zosmfOnly) continue;
    const props = {};
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      if (mvsmf && prop[ZOSMF_ONLY]) continue;
      const clean = { ...prop };
      if (mvsmf && clean.enum && prop[MVSMF_DROP]) {
        clean.enum = clean.enum.filter((v) => !prop[MVSMF_DROP].includes(v));
      }
      props[key] = clean;
    }
    out.push({ ...tool, inputSchema: { ...tool.inputSchema, properties: props } });
  }
  return out;
}

const TOOLS = toolsForMode(MVSMF);
const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));
const ZOSMF_TOOL_INDEX = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// Check a call against the active mode's schema: unknown or disabled options,
// enum values and required fields. The low-level Server does not validate.
function callArgs(name, args) {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    if (ZOSMF_TOOL_INDEX.has(name)) throw new Error(`Tool "${name}" is not supported by mvsMF and is disabled in mvsmf compatibility mode (ZOSMF_MODE=mvsmf).`);
    throw new Error(`Unknown tool: ${name}`);
  }
  const { properties, required = [] } = tool.inputSchema;
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) continue;
    const prop = properties[key];
    if (!prop) {
      if (ZOSMF_TOOL_INDEX.get(name).inputSchema.properties[key]) {
        throw new Error(`Option "${key}" of ${name} is not supported by mvsMF and is disabled in mvsmf compatibility mode.`);
      }
      throw new Error(`Unknown option "${key}" for ${name}.`);
    }
    if (prop.enum && !prop.enum.includes(args[key])) {
      const full = ZOSMF_TOOL_INDEX.get(name).inputSchema.properties[key]?.enum || [];
      const why = full.includes(args[key]) ? 'is not supported by mvsMF and is disabled in mvsmf compatibility mode' : `is not one of ${prop.enum.join(', ')}`;
      throw new Error(`${name}: ${key}="${args[key]}" ${why}.`);
    }
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) throw new Error(`${name}: "${key}" is required.`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function setIf(params, key, value) {
  if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
}

// Header set shared by the three submit variants.
function submitHeaders(args, contentType) {
  const h = { 'Content-Type': contentType };
  if (args.intrdrClass) h['X-IBM-Intrdr-Class'] = args.intrdrClass;
  if (args.intrdrRecfm) h['X-IBM-Intrdr-Recfm'] = args.intrdrRecfm;
  if (args.intrdrLrecl !== undefined) h['X-IBM-Intrdr-Lrecl'] = String(args.intrdrLrecl);
  if (args.notificationUrl) h['X-IBM-Notification-URL'] = args.notificationUrl;
  for (const [k, v] of Object.entries(args.symbols || {})) h[`X-IBM-JCL-Symbol-${k}`] = String(v);
  return h;
}

function jobModifyHeaders(args) {
  return { 'X-IBM-Job-Modify-Version': args.synchronous === false ? '1.0' : '2.0' };
}

async function jobModify(args, body) {
  return textResult(
    await zosmfFetch(jobPath(args.jobname, args.jobid), jsonBody('PUT', { ...body, version: args.synchronous === false ? '1.0' : '2.0' }, jobModifyHeaders(args)))
  );
}

async function ussUtility(path, body) {
  return textResult(await zosmfFetch(`/zosmf/restfiles/fs/${ussPath(path)}`, jsonBody('PUT', body)));
}

async function callTool(name, args) {
  switch (name) {
    case 'zosmfInfo':
      return textResult(await zosmfFetch('/zosmf/info'));

    // --- Datasets ---
    case 'listDatasets': {
      const params = new URLSearchParams({ dslevel: args.dslevel });
      setIf(params, 'volser', args.volser);
      setIf(params, 'start', args.start);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      if (!MVSMF) headers['X-IBM-Attributes'] = args.attributes || 'base';
      return textResult(await zosmfFetch(`/zosmf/restfiles/ds?${params}`, { headers }));
    }

    case 'createDataset': {
      const body = {};
      for (const k of ['like', 'dsorg', 'recfm', 'lrecl', 'blksize', 'primary', 'secondary', 'dirblk', 'alcunit', 'dsntype', 'volser', 'unit', 'avgblk', 'storclass', 'mgntclass', 'dataclass']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return textResult(await zosmfFetch(dsPath(args.dsname), jsonBody('POST', body)));
    }

    case 'deleteDataset':
      return textResult(await zosmfFetch(dsPath(args.dsname, undefined, args.volser), { method: 'DELETE' }));

    case 'readDataset':
      return readDatasetLike(dsPath(args.dsname, undefined, args.volser), args.dsname, args);

    case 'writeDataset':
      return writeDatasetLike(dsPath(args.dsname, undefined, args.volser), args.dsname, args);

    case 'renameDataset': {
      const memberRename = args.member !== undefined || args.newMember !== undefined;
      if (memberRename && !(args.member && args.newMember)) throw new Error('A member rename needs both member and newMember.');
      if (!memberRename && !args.newDsname) throw new Error('Give newDsname (data set rename) or member + newMember (member rename).');
      const from = { dsn: args.dsname, ...(memberRename ? { member: args.member } : {}) };
      const body = { request: 'rename', 'from-dataset': from, ...(args.enq ? { enq: args.enq } : {}) };
      const target = memberRename ? dsPath(args.dsname, args.newMember) : dsPath(args.newDsname);
      return textResult(await zosmfFetch(target, jsonBody('PUT', body)));
    }

    case 'copyDataset': {
      const from = { dsn: args.fromDsname };
      if (args.fromMember) from.member = args.fromMember;
      if (args.fromVolser) from.volser = args.fromVolser;
      if (args.alias !== undefined) from.alias = args.alias;
      const body = { request: 'copy', 'from-dataset': from };
      if (args.replace !== undefined) body.replace = args.replace;
      if (args.enq) body.enq = args.enq;
      return textResult(await zosmfFetch(dsPath(args.toDsname, args.toMember), jsonBody('PUT', body)));
    }

    case 'hsmRequest': {
      const body = { request: args.request };
      if (args.wait !== undefined) body.wait = args.wait;
      if (args.purge !== undefined) body.purge = args.purge;
      return textResult(await zosmfFetch(dsPath(args.dsname), jsonBody('PUT', body)));
    }

    case 'listMembers': {
      const params = new URLSearchParams();
      setIf(params, 'pattern', args.pattern);
      setIf(params, 'start', args.start);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      if (args.attributes) headers['X-IBM-Attributes'] = args.attributes;
      const qs = params.toString();
      return textResult(await zosmfFetch(`${dsPath(args.dsname, undefined, args.volser)}/member${qs ? `?${qs}` : ''}`, { headers }));
    }

    case 'readMember':
      return readDatasetLike(dsPath(args.dsname, args.member, args.volser), args.dsname, args);

    case 'writeMember':
      return writeDatasetLike(dsPath(args.dsname, args.member, args.volser), args.dsname, args);

    case 'deleteMember':
      return textResult(await zosmfFetch(dsPath(args.dsname, args.member, args.volser), { method: 'DELETE' }));

    // --- USS ---
    case 'listUssFiles': {
      const params = new URLSearchParams({ path: args.path });
      for (const k of ['name', 'depth', 'type', 'filesys', 'symlinks']) setIf(params, k, args[k]);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      return textResult(await zosmfFetch(`/zosmf/restfiles/fs?${params}`, { headers }));
    }

    case 'readUssFile':
      return textResult(
        await zosmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          headers: readHeaders(args),
          binary: args.dataType === 'binary',
        })
      );

    case 'writeUssFile': {
      if (args.encoding) throw new Error('encoding is only supported for data sets; USS files have no LRECL.');
      const { body, dataType } = await writeBody(args);
      return textResult(
        await zosmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'PUT',
          headers: writeHeaders(args, dataType),
          body,
        })
      );
    }

    case 'createUssFile':
      return textResult(
        await zosmfFetch(
          `/zosmf/restfiles/fs/${ussPath(args.path)}`,
          jsonBody('POST', { type: args.isDirectory ? 'directory' : 'file', ...(args.mode ? { mode: args.mode } : {}) })
        )
      );

    case 'deleteUssFile':
      return textResult(
        await zosmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'DELETE',
          headers: args.recursive ? { 'X-IBM-Option': 'recursive' } : {},
        })
      );

    case 'chmodUssFile': {
      const body = { request: 'chmod', mode: args.mode };
      if (args.recursive !== undefined) body.recursive = args.recursive;
      if (args.links) body.links = args.links;
      return ussUtility(args.path, body);
    }

    case 'chownUssFile': {
      const body = { request: 'chown', owner: args.owner };
      if (args.group) body.group = args.group;
      if (args.recursive !== undefined) body.recursive = args.recursive;
      if (args.links) body.links = args.links;
      return ussUtility(args.path, body);
    }

    case 'chtagUssFile': {
      const body = { request: 'chtag', action: args.action };
      if (args.type) body.type = args.type;
      if (args.codeset) body.codeset = args.codeset;
      if (args.recursive !== undefined) body.recursive = args.recursive;
      if (args.links) body.links = args.links;
      return ussUtility(args.path, body);
    }

    case 'moveUssFile': {
      const body = { request: 'move', from: args.from };
      if (args.overwrite !== undefined) body.overwrite = args.overwrite;
      return ussUtility(args.to, body);
    }

    case 'copyUssFile': {
      const body = { request: 'copy', from: args.from };
      if (args.overwrite !== undefined) body.overwrite = args.overwrite;
      if (args.recursive !== undefined) body.recursive = args.recursive;
      return ussUtility(args.to, body);
    }

    // --- Jobs ---
    case 'listJobs': {
      const params = new URLSearchParams();
      for (const k of ['owner', 'prefix', 'jobid', 'status']) setIf(params, k, args[k]);
      setIf(params, 'max-jobs', args.maxJobs);
      setIf(params, 'user-correlator', args.userCorrelator);
      if (args.execData) params.set('exec-data', 'Y');
      const qs = params.toString();
      return textResult(await zosmfFetch(`/zosmf/restjobs/jobs${qs ? `?${qs}` : ''}`));
    }

    case 'getJobStatus': {
      const params = new URLSearchParams();
      if (args.execData) params.set('exec-data', 'Y');
      if (args.stepData) params.set('step-data', 'Y');
      const qs = params.toString();
      return textResult(await zosmfFetch(`${jobPath(args.jobname, args.jobid)}${qs ? `?${qs}` : ''}`));
    }

    case 'listJobFiles':
      return textResult(await zosmfFetch(`${jobPath(args.jobname, args.jobid)}/files`));

    case 'readJobFile':
      return textResult(await zosmfFetch(`${jobPath(args.jobname, args.jobid)}/files/${enc(args.ddid)}/records`, { headers: readHeaders(args) }));

    case 'getJobJcl':
      return textResult(await zosmfFetch(`${jobPath(args.jobname, args.jobid)}/files/JCL/records`));

    case 'submitJob':
      return textResult(await zosmfFetch('/zosmf/restjobs/jobs', { method: 'PUT', headers: submitHeaders(args, 'text/plain'), body: args.jcl }));

    case 'submitJobFromDataset': {
      // Both servers accept exactly the //'DSN(MEM)' form.
      const bare = args.dsname.trim().replace(/^\/\//, '').replace(/^'|'$/g, '');
      return textResult(
        await zosmfFetch('/zosmf/restjobs/jobs', {
          method: 'PUT',
          headers: submitHeaders(args, 'application/json'),
          body: JSON.stringify({ file: `//'${bare}'` }),
        })
      );
    }

    case 'submitJobFromUssFile':
      return textResult(
        await zosmfFetch('/zosmf/restjobs/jobs', {
          method: 'PUT',
          headers: submitHeaders(args, 'application/json'),
          body: JSON.stringify({ file: args.path }),
        })
      );

    case 'purgeJob':
      return textResult(
        await zosmfFetch(jobPath(args.jobname, args.jobid), {
          method: 'DELETE',
          headers: MVSMF ? {} : jobModifyHeaders(args),
        })
      );

    case 'cancelJob':
      return jobModify(args, { request: 'cancel' });

    case 'holdJob':
      return jobModify(args, { request: 'hold' });

    case 'releaseJob':
      return jobModify(args, { request: 'release' });

    case 'changeJobClass':
      return jobModify(args, { class: args.class });

    // --- Console services ---
    case 'issueConsoleCommand': {
      const body = { cmd: args.cmd };
      if (args.async) body.async = 'Y';
      if (args.solKey) body['sol-key'] = args.solKey;
      if (args.unsolKey) body['unsol-key'] = args.unsolKey;
      if (args.unsolDetectSync) body['unsol-detect-sync'] = 'Y';
      if (args.unsolDetectTimeout !== undefined) body['unsol-detect-timeout'] = String(args.unsolDetectTimeout);
      if (args.detectTime !== undefined) body['detect-time'] = String(args.detectTime);
      if (args.system) body.system = args.system;
      return textResult(await zosmfFetch(consolePath(args.consoleName), jsonBody('PUT', body)));
    }

    case 'getConsoleMessages':
      return textResult(await zosmfFetch(`${consolePath(args.consoleName)}/solmsgs/${enc(args.key)}`));

    case 'getConsoleDetections':
      return textResult(await zosmfFetch(`${consolePath(args.consoleName)}/detections/${enc(args.key)}`));

    case 'getHardcopyLog': {
      const params = new URLSearchParams();
      for (const k of ['timeRange', 'time', 'timestamp', 'direction', 'hardcopy', 'sysName']) setIf(params, k, args[k]);
      const qs = params.toString();
      return textResult(await zosmfFetch(`/zosmf/restconsoles/v1/log${qs ? `?${qs}` : ''}`));
    }

    // --- TSO ---
    case 'issueTsoCommand': {
      const params = new URLSearchParams();
      setIf(params, 'acct', args.account);
      setIf(params, 'proc', args.proc);
      setIf(params, 'rsize', args.regionSize);
      setIf(params, 'chset', args.characterSet);
      setIf(params, 'cpage', args.codePage);
      const qs = params.toString();
      return textResult(await zosmfFetch(`/zosmf/tsoApp/v1/tso${qs ? `?${qs}` : ''}`, jsonBody('PUT', { tsoCmd: args.command, cmdState: 'stateless' })));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'zosmf-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, callArgs(name, args || {}));
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`zosmf-mcp connected (mode=${MODE}, base=${BASE_URL}, user=${USER || '(none)'}, tools=${TOOLS.length}/${ALL_TOOLS.length})`);
