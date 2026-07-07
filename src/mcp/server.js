#!/usr/bin/env node
/**
 * MCP server (ARCHITECTURE STUB — next phase).
 *
 * Exposes pahe-watcher as Model Context Protocol tools so an LLM/agent can drive
 * it: list new posts, resolve a link, check job status, read the sheet target.
 *
 * This reuses the SAME core modules as the web GUI (createApp) — the MCP layer
 * is just another transport over the app context, exactly like the REST API.
 * That is the whole point of the modular design: watcher/parser/bypass/queue/
 * sheets have no knowledge of HTTP or MCP.
 *
 * To activate:
 *   1) npm install @modelcontextprotocol/sdk   (already an optionalDependency)
 *   2) uncomment the SDK wiring below
 *   3) npm run mcp    (or add to your MCP client config as a stdio server)
 *
 * Planned tools (see ARCHITECTURE.md → "MCP surface"):
 *   watcher_poll()                      -> { found }
 *   list_posts({ limit })               -> PostEntry[]
 *   list_jobs({ status })               -> Job[]
 *   resolve_link({ url, provider })     -> { jobId } (async) or { finalUrl }
 *   resolve_post({ postId, providers }) -> { jobIds }
 *   job_status({ jobId })               -> Job
 *   sheet_status()                      -> { configured, title }
 */

import { createApp } from '../app.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('mcp');

/** Tool definitions shared with the SDK wiring (kept declarative + testable). */
export function buildTools(app) {
  return [
    {
      name: 'watcher_poll',
      description: 'Poll pahe.ink now for new posts. Returns how many new posts were found.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => app.watcher.poll(),
    },
    {
      name: 'list_posts',
      description: 'List recently seen posts with their parsed download options.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async ({ limit = 20 }) => app.store.listPosts().slice(0, limit),
    },
    {
      name: 'list_jobs',
      description: 'List bypass jobs, optionally filtered by status.',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      handler: async ({ status }) =>
        app.store.listJobs().filter((j) => !status || j.status === status),
    },
    {
      name: 'resolve_link',
      description: 'Enqueue a bypass job to resolve a single shortener/entry URL to a final download link.',
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' }, provider: { type: 'string' }, quality: { type: 'string' } },
      },
      handler: async ({ url, provider = 'GD', quality = null }) =>
        app.queue.enqueue({ url, provider, quality, title: 'mcp', postLink: '' }),
    },
    {
      name: 'resolve_post',
      description: 'Enqueue bypass jobs for a post’s matching provider/quality options.',
      inputSchema: {
        type: 'object',
        required: ['postId'],
        properties: { postId: { type: 'number' }, providers: { type: 'array', items: { type: 'string' } } },
      },
      handler: async ({ postId, providers }) => {
        const post = app.store.getPost(postId);
        if (!post) throw new Error('post not found');
        const want = (providers || app.runtime.watcher.preferredProviders).map((p) => p.toUpperCase());
        const jobs = (post.options || [])
          .filter((o) => want.includes(o.provider))
          .map((o) => app.queue.enqueue({ postId, title: post.title, postLink: post.link, provider: o.provider, quality: o.quality, url: o.url }));
        return { jobIds: jobs.map((j) => j.id) };
      },
    },
    {
      name: 'job_status',
      description: 'Get the current state (and result) of a bypass job by id.',
      inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
      handler: async ({ jobId }) => app.store.getJob(jobId),
    },
    {
      name: 'sheet_status',
      description: 'Check the Google Sheet target connection.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => app.sheets.testConnection(),
    },
  ];
}

async function main() {
  const app = await createApp();
  const tools = buildTools(app);
  log.info(`MCP tool surface ready: ${tools.map((t) => t.name).join(', ')}`);

  // ── SDK wiring (uncomment once @modelcontextprotocol/sdk is installed) ──
  //
  // import { Server } from '@modelcontextprotocol/sdk/server/index.js';
  // import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
  // import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
  //
  // const server = new Server({ name: 'pahe-watcher', version: '0.1.0' }, { capabilities: { tools: {} } });
  // server.setRequestHandler(ListToolsRequestSchema, async () => ({
  //   tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  // }));
  // server.setRequestHandler(CallToolRequestSchema, async (req) => {
  //   const tool = tools.find((t) => t.name === req.params.name);
  //   if (!tool) throw new Error(`unknown tool ${req.params.name}`);
  //   const result = await tool.handler(req.params.arguments || {});
  //   return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  // });
  // await server.connect(new StdioServerTransport());
  // log.info('MCP stdio server connected');

  log.warn('MCP SDK wiring is commented out. Install @modelcontextprotocol/sdk and enable it. See this file + ARCHITECTURE.md.');
  await app.shutdown();
  process.exit(0);
}

// Only run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  main().catch((err) => {
    log.error('MCP fatal', { error: String(err) });
    process.exit(1);
  });
}
