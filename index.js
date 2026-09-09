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

function authHeader() {
  if (!USER || !PASSWORD) return {};
  const b64 = Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${b64}` };
}

async function mvsmfFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...authHeader(), ...headers },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed, headers: Object.fromEntries(res.headers) };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function ussPath(path) {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

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
      'List cataloged data sets matching a filter pattern (GET /zosmf/restfiles/ds). Supports wildcards like "USER.*" or "USER.**".',
    inputSchema: {
      type: 'object',
      properties: {
        dslevel: { type: 'string', description: 'Data set name filter, e.g. "SYS1.**" or "USER.TEST.DATA"' },
        volser: { type: 'string', description: 'Optional volume serial filter' },
        start: { type: 'string', description: 'Optional starting data set name for pagination' },
        maxItems: { type: 'integer', description: 'Optional max items (X-IBM-Max-Items), 0 = unlimited' },
      },
      required: ['dslevel'],
      additionalProperties: false,
    },
  },
  {
    name: 'readDataset',
    description:
      'Read the content of a sequential (PS) data set (GET /zosmf/restfiles/ds/{name}). PDS data sets return 400; use readMember instead.',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'Fully qualified data set name' } },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'listMembers',
    description: 'List members of a PDS (GET /zosmf/restfiles/ds/{name}/member).',
    inputSchema: {
      type: 'object',
      properties: { dsname: { type: 'string', description: 'PDS name' } },
      required: ['dsname'],
      additionalProperties: false,
    },
  },
  {
    name: 'readMember',
    description: 'Read a single PDS member (GET /zosmf/restfiles/ds/{name}({member})).',
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
  {
    name: 'writeDataset',
    description:
      'Write/overwrite the content of a sequential (PS) data set (PUT /zosmf/restfiles/ds/{name}). Caution: overwrites the existing content of a real MVS data set.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'Fully qualified data set name' },
        content: { type: 'string', description: 'New content to write (text)' },
      },
      required: ['dsname', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeMember',
    description:
      'Write/overwrite a single PDS member (PUT /zosmf/restfiles/ds/{name}({member})). Caution: overwrites the existing content of a real MVS PDS member, or creates it if absent.',
    inputSchema: {
      type: 'object',
      properties: {
        dsname: { type: 'string', description: 'PDS name' },
        member: { type: 'string', description: 'Member name (max 8 chars)' },
        content: { type: 'string', description: 'New content to write (text)' },
      },
      required: ['dsname', 'member', 'content'],
      additionalProperties: false,
    },
  },

  // --- USS (UNIX System Services) ---
  {
    name: 'listUssFiles',
    description: 'List a USS directory (GET /zosmf/restfiles/fs?path=...).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute USS directory path, e.g. "/u/herc01"' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'readUssFile',
    description: 'Read the content of a USS file (GET /zosmf/restfiles/fs/{filepath}).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute USS file path, e.g. "/u/herc01/profile"' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'writeUssFile',
    description:
      'Write/overwrite the content of a USS file (PUT /zosmf/restfiles/fs/{filepath}). Caution: overwrites the existing content of a real file, or creates it if absent.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute USS file path' },
        content: { type: 'string', description: 'New content to write (text)' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'createUssFile',
    description:
      'Create a new USS file or directory (POST /zosmf/restfiles/fs/{filepath}). Caution: creates real filesystem entries on the guest.',
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
    description: 'List JES2 jobs (GET /zosmf/restjobs/jobs).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Job owner filter, "*" for all owners' },
        prefix: { type: 'string', description: 'Job name prefix filter, "*" for all' },
        jobid: { type: 'string', description: 'Specific job id filter' },
        status: { type: 'string', description: 'INPUT|ACTIVE|OUTPUT|* (also XMIT/SETUP/RECEIVE/UNKNOWN on 3.8j)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getJobStatus',
    description: 'Get a job\'s status (GET /zosmf/restjobs/jobs/{jobname}/{jobid}).',
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
      'Read the record content of one job spool file (GET /zosmf/restjobs/jobs/{jobname}/{jobid}/files/{ddid}/records).',
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
      'Submit a job by inline JCL text (PUT /zosmf/restjobs/jobs, Content-Type: text/plain). Use with care: this executes real batch work on the guest MVS system.',
    inputSchema: {
      type: 'object',
      properties: { jcl: { type: 'string', description: 'Full inline JCL text, including the JOB card' } },
      required: ['jcl'],
      additionalProperties: false,
    },
  },
  {
    name: 'purgeJob',
    description:
      'Purge/cancel a job from JES2 (DELETE /zosmf/restjobs/jobs/{jobname}/{jobid}). Caution: removes a job from the queue, including an active one; irreversible.',
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
      'Issue an MVS operator command (PUT /zosmf/restconsoles/consoles/{consoleName}). Caution: operator commands can affect the whole shared MVS guest (start/stop subsystems, cancel jobs, etc). Returns a cmd-response-key to pass to getConsoleMessages.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Operator command text, e.g. "D T" or "D A"' },
        consoleName: { type: 'string', description: 'Console name. Default "defcn".' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'getConsoleMessages',
    description:
      'Collect solicited command-response messages for a prior issueConsoleCommand call (GET /zosmf/restconsoles/consoles/{consoleName}/solmsgs/{key}).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'cmd-response-key returned by issueConsoleCommand' },
        consoleName: { type: 'string', description: 'Console name. Default "defcn".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'getConsoleDetections',
    description:
      'Detect a keyword among unsolicited console messages (GET /zosmf/restconsoles/consoles/{consoleName}/detections/{key}).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Detection key previously registered on the console' },
        consoleName: { type: 'string', description: 'Console name. Default "defcn".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'getHardcopyLog',
    description: 'Retrieve hardcopy log messages (GET /zosmf/restconsoles/v1/log).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'mvsmfInfo':
      return textResult(await mvsmfFetch('/zosmf/info'));

    case 'listDatasets': {
      const params = new URLSearchParams({ dslevel: args.dslevel });
      if (args.volser) params.set('volser', args.volser);
      if (args.start) params.set('start', args.start);
      const headers = {};
      if (args.maxItems !== undefined) headers['X-IBM-Max-Items'] = String(args.maxItems);
      return textResult(await mvsmfFetch(`/zosmf/restfiles/ds?${params}`, { headers }));
    }

    case 'readDataset':
      return textResult(await mvsmfFetch(`/zosmf/restfiles/ds/${encodeURIComponent(args.dsname)}`));

    case 'listMembers':
      return textResult(await mvsmfFetch(`/zosmf/restfiles/ds/${encodeURIComponent(args.dsname)}/member`));

    case 'readMember':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/ds/${encodeURIComponent(args.dsname)}(${args.member})`)
      );

    case 'writeDataset':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/ds/${encodeURIComponent(args.dsname)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: args.content,
        })
      );

    case 'writeMember':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/ds/${encodeURIComponent(args.dsname)}(${args.member})`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: args.content,
        })
      );

    case 'listUssFiles': {
      const params = new URLSearchParams({ path: args.path });
      return textResult(await mvsmfFetch(`/zosmf/restfiles/fs?${params}`));
    }

    case 'readUssFile':
      return textResult(await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`));

    case 'writeUssFile':
      return textResult(
        await mvsmfFetch(`/zosmf/restfiles/fs/${ussPath(args.path)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: args.content,
        })
      );

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

    case 'listJobs': {
      const params = new URLSearchParams();
      for (const k of ['owner', 'prefix', 'jobid', 'status']) if (args[k]) params.set(k, args[k]);
      return textResult(await mvsmfFetch(`/zosmf/restjobs/jobs?${params}`));
    }

    case 'getJobStatus':
      return textResult(await mvsmfFetch(`/zosmf/restjobs/jobs/${args.jobname}/${args.jobid}`));

    case 'listJobFiles':
      return textResult(await mvsmfFetch(`/zosmf/restjobs/jobs/${args.jobname}/${args.jobid}/files`));

    case 'readJobFile':
      return textResult(
        await mvsmfFetch(`/zosmf/restjobs/jobs/${args.jobname}/${args.jobid}/files/${args.ddid}/records`)
      );

    case 'submitJob':
      return textResult(
        await mvsmfFetch('/zosmf/restjobs/jobs', {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: args.jcl,
        })
      );

    case 'purgeJob':
      return textResult(
        await mvsmfFetch(`/zosmf/restjobs/jobs/${args.jobname}/${args.jobid}`, { method: 'DELETE' })
      );

    case 'issueConsoleCommand':
      return textResult(
        await mvsmfFetch(`/zosmf/restconsoles/consoles/${args.consoleName || 'defcn'}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd: args.cmd }),
        })
      );

    case 'getConsoleMessages':
      return textResult(
        await mvsmfFetch(`/zosmf/restconsoles/consoles/${args.consoleName || 'defcn'}/solmsgs/${args.key}`)
      );

    case 'getConsoleDetections':
      return textResult(
        await mvsmfFetch(`/zosmf/restconsoles/consoles/${args.consoleName || 'defcn'}/detections/${args.key}`)
      );

    case 'getHardcopyLog':
      return textResult(await mvsmfFetch('/zosmf/restconsoles/v1/log'));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'mvsmf-mcp-bridge', version: '1.0.0' },
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
