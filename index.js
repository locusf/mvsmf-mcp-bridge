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

const TOOLS = [
  {
    name: 'mvsmfInfo',
    description:
      'Get z/OSMF system information from the mvsMF instance (GET /zosmf/info). Requires valid credentials; a real z/OSMF also 401s this endpoint without auth.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
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
