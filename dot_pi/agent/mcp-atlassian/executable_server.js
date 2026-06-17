#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const sdkRoot = join(HOME, '.pi', 'agent', 'npm', 'node_modules');
const { McpServer } = await import(pathToFileURL(join(sdkRoot, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'mcp.js')).href);
const { StdioServerTransport } = await import(pathToFileURL(join(sdkRoot, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'server', 'stdio.js')).href);
const z = await import(pathToFileURL(join(sdkRoot, 'zod', 'v4', 'index.js')).href);

function loadConfig() {
  const configPath = process.env.CONFLUENCE_CONFIG || join(HOME, '.pi', 'agent', 'confluence.json');
  if (!existsSync(configPath)) {
    throw new Error(`Atlassian credentials not configured: missing ${configPath}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const rawBase = (process.env.JIRA_BASE_URL || process.env.ATLASSIAN_BASE_URL || cfg.jiraBaseUrl || cfg.baseUrl || 'https://nebius.atlassian.net').replace(/\/$/, '');
  const baseUrl = rawBase.includes('/wiki') ? rawBase.split('/wiki')[0] : rawBase;
  const email = process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL || process.env.CONFLUENCE_EMAIL || cfg.email;
  const apiToken = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN || process.env.CONFLUENCE_API_TOKEN || cfg.apiToken;
  const bearerToken = process.env.JIRA_BEARER_TOKEN || process.env.ATLASSIAN_BEARER_TOKEN || cfg.bearerToken;
  let authorization;
  if (bearerToken) authorization = `Bearer ${bearerToken}`;
  else if (email && apiToken) authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  if (!authorization) {
    throw new Error('Atlassian credentials not configured: expected email + apiToken or bearerToken in ~/.pi/agent/confluence.json or environment');
  }
  return { baseUrl, authorization };
}

async function jiraRequest(path, options = {}) {
  const { baseUrl, authorization } = loadConfig();
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const message = typeof data === 'object' && data ? JSON.stringify(data) : String(data || response.statusText);
    throw new Error(`Jira API ${response.status} ${response.statusText}: ${message}`);
  }
  return data;
}

function userName(user) {
  return user?.displayName || user?.name || user?.emailAddress || null;
}

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).filter(Boolean).join('\n');
  if (typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  const content = Array.isArray(node.content) ? node.content.map(adfToText).filter(Boolean) : [];
  const joined = content.join(node.type === 'paragraph' ? '' : '\n');
  return joined;
}

function summarizeIssue(issue, includeDescription = false) {
  const f = issue.fields || {};
  const out = {
    key: issue.key,
    id: issue.id,
    url: issue.self ? issue.self.replace(/\/rest\/api\/3\/issue\/.*/, `/browse/${issue.key}`) : undefined,
    summary: f.summary || null,
    status: f.status?.name || null,
    assignee: userName(f.assignee),
    reporter: userName(f.reporter),
    type: f.issuetype?.name || null,
    priority: f.priority?.name || null,
    labels: f.labels || [],
    components: Array.isArray(f.components) ? f.components.map((c) => c.name) : [],
    fixVersions: Array.isArray(f.fixVersions) ? f.fixVersions.map((v) => v.name) : [],
    created: f.created || null,
    updated: f.updated || null,
  };
  if (includeDescription) out.descriptionText = adfToText(f.description).slice(0, 20000);
  return out;
}

function fieldsList(fields, includeDescription = false) {
  const base = fields?.trim() || 'summary,status,assignee,reporter,issuetype,priority,labels,components,fixVersions,created,updated';
  return includeDescription && !base.split(',').includes('description') ? `${base},description` : base;
}

const server = new McpServer({ name: 'atlassian-jira', version: '1.0.0' });

server.registerTool('jira_get_issue', {
  description: 'Read a Jira issue using local Atlassian credentials from ~/.pi/agent/confluence.json. Returns selected issue fields; never returns credential values.',
  inputSchema: {
    issueKey: z.string().min(1).describe('Jira issue key, e.g. AIBE-3152'),
    fields: z.string().optional().describe('Optional comma-separated Jira fields to request'),
    includeDescription: z.boolean().default(false).describe('Include plain-text description, truncated to 20KB'),
    raw: z.boolean().default(false).describe('Return raw Jira JSON instead of normalized summary'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ issueKey, fields, includeDescription, raw }) => {
  const key = issueKey.trim().toUpperCase();
  const qs = new URLSearchParams({ fields: fieldsList(fields, includeDescription) });
  const issue = await jiraRequest(`/rest/api/3/issue/${encodeURIComponent(key)}?${qs.toString()}`);
  const result = raw ? issue : summarizeIssue(issue, includeDescription);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.registerTool('jira_search', {
  description: 'Run a read-only Jira JQL search using local Atlassian credentials. Returns normalized issue summaries by default.',
  inputSchema: {
    jql: z.string().min(1).describe('Jira Query Language string'),
    maxResults: z.number().int().min(1).max(50).default(10),
    fields: z.string().optional().describe('Optional comma-separated Jira fields to request'),
    includeDescription: z.boolean().default(false),
    raw: z.boolean().default(false),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ jql, maxResults, fields, includeDescription, raw }) => {
  const body = { jql, maxResults, fields: fieldsList(fields, includeDescription).split(',').map((s) => s.trim()).filter(Boolean) };
  let data;
  try {
    data = await jiraRequest('/rest/api/3/search', { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (!String(error?.message || error).includes('410')) throw error;
    const qs = new URLSearchParams({ jql, maxResults: String(maxResults), fields: body.fields.join(',') });
    data = await jiraRequest(`/rest/api/3/search?${qs.toString()}`);
  }
  const result = raw ? data : { total: data.total, startAt: data.startAt, maxResults: data.maxResults, issues: (data.issues || []).map((issue) => summarizeIssue(issue, includeDescription)) };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.registerTool('jira_auth_status', {
  description: 'Check whether local Atlassian/Jira credentials are configured and can call Jira /myself. Does not return credential values.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async () => {
  const { baseUrl } = loadConfig();
  const me = await jiraRequest('/rest/api/3/myself');
  return { content: [{ type: 'text', text: JSON.stringify({ configured: true, baseUrl, accountType: me.accountType, displayName: me.displayName, emailAddress: me.emailAddress || null }, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
