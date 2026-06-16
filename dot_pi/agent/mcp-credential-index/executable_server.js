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

const rel = (p) => p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;

function parseDotEnvKeys(path) {
  const result = { exists: existsSync(path), keysPresent: [], missingKeys: [], parseError: undefined };
  if (!result.exists) return result;
  try {
    const text = readFileSync(path, 'utf8');
    const keys = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const key = line.split('=', 1)[0]?.trim();
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (key && value) keys.add(key);
    }
    result.keysPresent = [...keys].sort();
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function parseJsonKeys(path) {
  const result = { exists: existsSync(path), keysPresent: [], missingKeys: [], parseError: undefined };
  if (!result.exists) return result;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      result.keysPresent = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== '').sort();
    }
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function getMcpServerNames() {
  const path = join(HOME, '.pi', 'agent', 'mcp.json');
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Object.keys(data.mcpServers || {}).sort();
  } catch {
    return [];
  }
}

function buildStatus() {
  const slackEnvPath = join(HOME, '.pi', 'agent', 'slack-mcp.env');
  const atlassianPath = join(HOME, '.pi', 'agent', 'confluence.json');
  const mcpPath = join(HOME, '.pi', 'agent', 'mcp.json');
  const slack = parseDotEnvKeys(slackEnvPath);
  const atlassian = parseJsonKeys(atlassianPath);
  const mcpServers = getMcpServerNames();
  const slackExpected = ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'];
  const atlassianExpected = ['baseUrl', 'email', 'apiToken'];
  slack.missingKeys = slackExpected.filter((k) => !slack.keysPresent.includes(k));
  atlassian.missingKeys = atlassianExpected.filter((k) => !atlassian.keysPresent.includes(k));
  return {
    home: HOME,
    note: 'Secret values are intentionally never returned by this MCP server.',
    slack: {
      configured: slack.exists && slack.missingKeys.length === 0,
      path: rel(slackEnvPath),
      expectedKeys: slackExpected,
      keysPresent: slack.keysPresent,
      missingKeys: slack.missingKeys,
      mcpServerConfigured: mcpServers.includes('slack'),
      mcpConfigPath: rel(mcpPath),
      parseError: slack.parseError,
    },
    atlassian: {
      configured: atlassian.exists && atlassian.missingKeys.length === 0,
      path: rel(atlassianPath),
      expectedKeys: atlassianExpected,
      keysPresent: atlassian.keysPresent,
      missingKeys: atlassian.missingKeys,
      aliases: ['jira', 'confluence'],
      parseError: atlassian.parseError,
    },
    mcpServers,
  };
}

function selectService(status, service) {
  if (!service || service === 'all') return status;
  if (service === 'jira' || service === 'confluence') return { [service]: status.atlassian, atlassian: status.atlassian };
  return { [service]: status[service] };
}

const server = new McpServer({ name: 'credential-index', version: '1.0.0' });

server.registerTool('credential_status', {
  description: 'Read-only check of configured local Slack and Atlassian/Jira/Confluence credentials. Returns paths and key names only; never secret values. Use before concluding Slack/Jira credentials are unavailable.',
  inputSchema: {
    service: z.enum(['all', 'slack', 'atlassian', 'jira', 'confluence']).default('all').describe('Credential area to check'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ service }) => {
  const status = buildStatus();
  const selected = selectService(status, service);
  return { content: [{ type: 'text', text: JSON.stringify(selected, null, 2) }] };
});

server.registerTool('credential_guidance', {
  description: 'Return the local integration credential lookup guidance agents should follow on this machine.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  return { content: [{ type: 'text', text: [
    '~ expands to /Users/alanyu on this machine.',
    'Before saying Slack is unavailable, check ~/.pi/agent/slack-mcp.env and ~/.pi/agent/mcp.json.',
    'Before saying Jira/Confluence/Atlassian is unavailable, check ~/.pi/agent/confluence.json.',
    'Do not print secret values; report only configured status, paths, and key names.',
  ].join('\n') }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
