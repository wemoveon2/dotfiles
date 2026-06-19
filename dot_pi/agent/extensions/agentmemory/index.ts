import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPlaintextBearerAuthGuard } from "./security.ts";

type TextBlock = { type?: string; text?: string };
type AssistantMessage = { role?: string; content?: unknown };
type SmartSearchResult = {
  title?: string;
  narrative?: string;
  type?: string;
  combinedScore?: number;
  score?: number;
  observation?: {
    title?: string;
    narrative?: string;
    type?: string;
  };
};

type HealthResponse = {
  status?: string;
  service?: string;
  version?: string;
  health?: {
    status?: string;
    notes?: string[];
  };
};

type AgentMemorySession = {
  id?: string;
  status?: string;
  project?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  observationCount?: number;
  summary?: string;
  firstPrompt?: string;
};

type AgentMemoryObservation = {
  id?: string;
  obsId?: string;
  type?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  timestamp?: string;
  importance?: number;
  files?: string[];
  sessionId?: string;
};

type AgentMemoryLesson = {
  id?: string;
  content?: string;
  context?: string;
  confidence?: number;
  project?: string;
  tags?: string[];
  updatedAt?: string;
  createdAt?: string;
};

type HttpMethod = "GET" | "POST" | "DELETE";

const DEFAULT_URL = process.env.AGENTMEMORY_URL || "http://localhost:3111";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

const POLICY = {
  recallLimit: Math.max(1, Math.min(5, Math.floor(envNumber("AGENTMEMORY_PI_RECALL_LIMIT", 3)))),
  recallMinScore: envNumber("AGENTMEMORY_PI_RECALL_MIN_SCORE", 0.01),
  autoCapture: envBool("AGENTMEMORY_PI_AUTO_CAPTURE", true),
  skipGeneric: envBool("AGENTMEMORY_PI_SKIP_GENERIC", true),
  projectScope: envBool("AGENTMEMORY_PI_PROJECT_SCOPE", true),
  requestTimeoutMs: Math.floor(envNumber("AGENTMEMORY_PI_REQUEST_TIMEOUT_MS", 3000)),
  metrics: envBool("AGENTMEMORY_PI_METRICS", true),
  metricsPath: process.env.AGENTMEMORY_PI_METRICS_PATH || path.join(process.env.HOME || ".", ".pi", "agent", "agentmemory-stats.json"),
};

type EndpointMetrics = { attempts: number; successes: number; failures: number; latencyMs: number[] };
type AgentMemoryMetrics = {
  startedAt: string;
  smartSearch: EndpointMetrics;
  remember: EndpointMetrics;
  observe: EndpointMetrics;
  health: EndpointMetrics;
  other: EndpointMetrics;
  recalledItems: number;
  injectedItems: number;
  filteredItems: number;
  autoCapturesConsidered: number;
  autoCapturesSkipped: number;
  autoCapturesSaved: number;
};

type AutoCaptureMetricSample = {
  timestamp: string;
  sessionId: string;
  project: string;
  promptPreview: string;
  responseChars: number;
  capture: boolean;
  reason: string;
};

type PersistedSessionMetrics = {
  sessionId: string;
  project: string;
  startedAt: string;
  endedAt: string;
  reason: string;
  metrics: AgentMemoryMetrics;
  autoCaptureSamples: AutoCaptureMetricSample[];
};

type PersistedMetricsFile = {
  version: 1;
  updatedAt: string;
  totals: AgentMemoryMetrics;
  sessions: PersistedSessionMetrics[];
};

function emptyEndpointMetrics(): EndpointMetrics {
  return { attempts: 0, successes: 0, failures: 0, latencyMs: [] };
}

function createMetrics(): AgentMemoryMetrics {
  return {
    startedAt: new Date().toISOString(),
    smartSearch: emptyEndpointMetrics(),
    remember: emptyEndpointMetrics(),
    observe: emptyEndpointMetrics(),
    health: emptyEndpointMetrics(),
    other: emptyEndpointMetrics(),
    recalledItems: 0,
    injectedItems: 0,
    filteredItems: 0,
    autoCapturesConsidered: 0,
    autoCapturesSkipped: 0,
    autoCapturesSaved: 0,
  };
}

function metricBucket(metrics: AgentMemoryMetrics, pathname: string): EndpointMetrics {
  if (pathname === "smart-search") return metrics.smartSearch;
  if (pathname === "remember") return metrics.remember;
  if (pathname === "observe") return metrics.observe;
  if (pathname === "health") return metrics.health;
  return metrics.other;
}

function recordEndpointMetric(metrics: AgentMemoryMetrics, pathname: string, success: boolean, latencyMs: number) {
  if (!POLICY.metrics) return;
  const bucket = metricBucket(metrics, pathname);
  bucket.attempts += 1;
  if (success) bucket.successes += 1;
  else bucket.failures += 1;
  bucket.latencyMs.push(Math.round(latencyMs));
  if (bucket.latencyMs.length > 200) bucket.latencyMs.splice(0, bucket.latencyMs.length - 200);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function formatEndpointMetrics(label: string, metrics: EndpointMetrics): string {
  const successRate = metrics.attempts ? `${Math.round((metrics.successes / metrics.attempts) * 100)}%` : "n/a";
  return `- ${label}: attempts=${metrics.attempts} success=${metrics.successes} failure=${metrics.failures} successRate=${successRate} p50=${percentile(metrics.latencyMs, 50)}ms p95=${percentile(metrics.latencyMs, 95)}ms`;
}

function formatMetrics(metrics: AgentMemoryMetrics, heading = `agentmemory Pi metrics since ${metrics.startedAt}`): string {
  return [
    heading,
    formatEndpointMetrics("smart-search", metrics.smartSearch),
    formatEndpointMetrics("remember", metrics.remember),
    formatEndpointMetrics("observe", metrics.observe),
    formatEndpointMetrics("health", metrics.health),
    formatEndpointMetrics("other", metrics.other),
    `- recall: recalled=${metrics.recalledItems} injected=${metrics.injectedItems} filtered=${metrics.filteredItems}`,
    `- auto-capture: considered=${metrics.autoCapturesConsidered} saved=${metrics.autoCapturesSaved} skipped=${metrics.autoCapturesSkipped}`,
    `- policy: recallLimit=${POLICY.recallLimit} recallMinScore=${POLICY.recallMinScore} autoCapture=${POLICY.autoCapture} projectScope=${POLICY.projectScope} timeoutMs=${POLICY.requestTimeoutMs} metricsPath=${POLICY.metricsPath}`,
  ].join("\n");
}

function cloneEndpointMetrics(value: EndpointMetrics): EndpointMetrics {
  return { ...value, latencyMs: [...value.latencyMs] };
}

function cloneMetrics(value: AgentMemoryMetrics): AgentMemoryMetrics {
  return {
    ...value,
    smartSearch: cloneEndpointMetrics(value.smartSearch),
    remember: cloneEndpointMetrics(value.remember),
    observe: cloneEndpointMetrics(value.observe),
    health: cloneEndpointMetrics(value.health),
    other: cloneEndpointMetrics(value.other),
  };
}

function mergeEndpointMetrics(target: EndpointMetrics, source: EndpointMetrics) {
  target.attempts += source.attempts || 0;
  target.successes += source.successes || 0;
  target.failures += source.failures || 0;
  target.latencyMs.push(...(source.latencyMs || []));
  if (target.latencyMs.length > 500) target.latencyMs.splice(0, target.latencyMs.length - 500);
}

function mergeMetrics(target: AgentMemoryMetrics, source: AgentMemoryMetrics) {
  mergeEndpointMetrics(target.smartSearch, source.smartSearch || emptyEndpointMetrics());
  mergeEndpointMetrics(target.remember, source.remember || emptyEndpointMetrics());
  mergeEndpointMetrics(target.observe, source.observe || emptyEndpointMetrics());
  mergeEndpointMetrics(target.health, source.health || emptyEndpointMetrics());
  mergeEndpointMetrics(target.other, source.other || emptyEndpointMetrics());
  target.recalledItems += source.recalledItems || 0;
  target.injectedItems += source.injectedItems || 0;
  target.filteredItems += source.filteredItems || 0;
  target.autoCapturesConsidered += source.autoCapturesConsidered || 0;
  target.autoCapturesSkipped += source.autoCapturesSkipped || 0;
  target.autoCapturesSaved += source.autoCapturesSaved || 0;
}

function emptyPersistedMetrics(): PersistedMetricsFile {
  return { version: 1, updatedAt: new Date().toISOString(), totals: createMetrics(), sessions: [] };
}

function normalizePersistedMetrics(raw: unknown): PersistedMetricsFile {
  if (!raw || typeof raw !== "object") return emptyPersistedMetrics();
  const data = raw as Partial<PersistedMetricsFile>;
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    totals: data.totals ? { ...createMetrics(), ...data.totals } as AgentMemoryMetrics : createMetrics(),
    sessions: Array.isArray(data.sessions) ? data.sessions.slice(-100) as PersistedSessionMetrics[] : [],
  };
}

async function readPersistedMetrics(): Promise<PersistedMetricsFile> {
  try {
    return normalizePersistedMetrics(JSON.parse(await readFile(POLICY.metricsPath, "utf8")));
  } catch {
    return emptyPersistedMetrics();
  }
}

async function persistSessionMetrics(entry: PersistedSessionMetrics): Promise<void> {
  if (!POLICY.metrics) return;
  const persisted = await readPersistedMetrics();
  persisted.updatedAt = new Date().toISOString();
  persisted.sessions.push(entry);
  if (persisted.sessions.length > 100) persisted.sessions.splice(0, persisted.sessions.length - 100);
  persisted.totals = persisted.totals || createMetrics();
  mergeMetrics(persisted.totals, entry.metrics);
  await mkdir(path.dirname(POLICY.metricsPath), { recursive: true });
  await writeFile(POLICY.metricsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

function formatPersistedMetricsSummary(persisted: PersistedMetricsFile): string {
  const recent = persisted.sessions.slice(-5).map((s) => `  - ${s.endedAt} ${s.reason} ${clip(s.project, 80)} recalled=${s.metrics.recalledItems} injected=${s.metrics.injectedItems} saved=${s.metrics.autoCapturesSaved} skipped=${s.metrics.autoCapturesSkipped}`);
  return [
    `persisted metrics: updated=${persisted.updatedAt} sessions=${persisted.sessions.length}`,
    formatMetrics(persisted.totals, "persisted totals"),
    recent.length ? ["recent sessions:", ...recent].join("\n") : "recent sessions: none",
  ].join("\n");
}

const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();
const TOOL_GUIDANCE = [
  "agentmemory is available for cross-session memory.",
  "Use memory_search to recall prior decisions, preferences, bugs, and workflows.",
  "Use memory_save when you discover durable facts worth remembering beyond this session.",
  "Use the session/profile/file/timeline/lesson/provenance memory tools only when they add task-relevant context.",
].join(" ");

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [] as string[];
      const block = part as TextBlock;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      return [] as string[];
    })
    .join("\n")
    .trim();
}

function getLastAssistantText(messages: unknown[]): string {
  for (const msg of [...messages].reverse()) {
    if (!msg || typeof msg !== "object") continue;
    const assistant = msg as AssistantMessage;
    if (assistant.role !== "assistant") continue;
    const text = getText(assistant.content);
    if (text) return text;
  }
  return "";
}

function clip(text: string, maxChars = 700): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

const TRIVIAL_PROMPT_RE = /^(ok|okay|yes|yep|yeah|thanks|thank you|continue|carry on|go on|proceed|analy[sz]e again|retry|try again|commit it)$/i;
const DURABLE_OUTCOME_RE = /\b(created|added|updated|modified|changed|moved|renamed|deleted|removed|fixed|implemented|configured|verified|validated|completed|documented|refined|decided|found|blocked|failed|committed|saved|installed|patched|reworked|migrated|closed)\b/i;

function isTrivialPrompt(prompt: string): boolean {
  return TRIVIAL_PROMPT_RE.test(prompt.replace(/\s+/g, " ").trim());
}

function autoCaptureDecision(prompt: string, assistantText: string): { capture: boolean; reason: string } {
  if (!POLICY.autoCapture) return { capture: false, reason: "disabled" };
  const durable = DURABLE_OUTCOME_RE.test(assistantText);
  if (isTrivialPrompt(prompt) && !durable) return { capture: false, reason: "trivial_prompt" };
  if (assistantText.replace(/\s+/g, " ").trim().length < 180 && !durable) return { capture: false, reason: "short_response" };
  if (!durable && !/[`\/]?[-\w]+\.(ts|tsx|js|jsx|json|md|py|go|rs|yaml|yml|toml|sh)\b/.test(assistantText)) {
    return { capture: false, reason: "no_durable_signal" };
  }
  return { capture: true, reason: durable ? "durable_outcome" : "file_context" };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function jsonPreview(value: unknown, maxChars = 8000): string {
  const text = JSON.stringify(value, null, 2) || "null";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}\n…[truncated]`;
}

function getSearchObservation(result: SmartSearchResult): SmartSearchResult {
  return result.observation ?? result;
}

function getSearchScore(result: SmartSearchResult): number | undefined {
  return result.combinedScore ?? result.score;
}

function getSearchTitle(result: SmartSearchResult): string {
  return getSearchObservation(result).title?.trim() || "";
}

function getSearchType(result: SmartSearchResult): string {
  return getSearchObservation(result).type?.trim() || "memory";
}

function getSearchNarrative(result: SmartSearchResult): string {
  return getSearchObservation(result).narrative?.trim() || "";
}

function isGenericSearchResult(result: SmartSearchResult): boolean {
  const title = getSearchTitle(result).toLowerCase();
  const type = getSearchType(result).toLowerCase();
  const narrative = getSearchNarrative(result);
  return (type === "other" || type === "conversation" || type === "memory")
    && (title === "conversation" || /^memory \d+$/.test(title) || title === "")
    && narrative.length < 160;
}

function filterRecallResults(results: SmartSearchResult[], limit: number): { kept: SmartSearchResult[]; filtered: SmartSearchResult[] } {
  const kept: SmartSearchResult[] = [];
  const filtered: SmartSearchResult[] = [];
  const genericScoreFloor = Math.max(POLICY.recallMinScore * 2, 0.02);
  for (const result of results) {
    const score = getSearchScore(result);
    const weak = typeof score === "number" && score < POLICY.recallMinScore;
    const generic = POLICY.skipGeneric && isGenericSearchResult(result) && (typeof score !== "number" || score < genericScoreFloor);
    if (weak || generic) {
      filtered.push(result);
      continue;
    }
    if (kept.length < limit) kept.push(result);
    else filtered.push(result);
  }
  return { kept, filtered };
}

function formatSearchResults(results: SmartSearchResult[]): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const title = getSearchTitle(result) || `Memory ${index + 1}`;
      const narrative = getSearchNarrative(result);
      const type = getSearchType(result);
      const score = getSearchScore(result);
      const scoreText = typeof score === "number" ? ` [score=${score.toFixed(3)}]` : "";
      return `- ${title} (${type})${scoreText}${narrative ? `: ${clip(narrative)}` : ""}`;
    })
    .join("\n");
}

function formatSessions(sessions: AgentMemorySession[], limit: number, project?: string): string {
  const filtered = project ? sessions.filter((session) => session.project === project || session.cwd === project) : sessions;
  const sorted = [...filtered].sort((a, b) => (b.updatedAt || b.startedAt || "").localeCompare(a.updatedAt || a.startedAt || ""));
  if (!sorted.length) return "No agentmemory sessions found.";
  return sorted
    .slice(0, limit)
    .map((session) => {
      const prompt = session.firstPrompt || session.summary || "";
      return [
        `- ${session.id || "unknown"}`,
        session.status ? `status=${session.status}` : "",
        typeof session.observationCount === "number" ? `observations=${session.observationCount}` : "",
        session.updatedAt || session.startedAt ? `updated=${session.updatedAt || session.startedAt}` : "",
        session.cwd || session.project ? `cwd=${session.cwd || session.project}` : "",
        prompt ? `prompt=${clip(prompt, 180)}` : "",
      ].filter(Boolean).join(" | ");
    })
    .join("\n");
}

function formatObservations(observations: AgentMemoryObservation[], limit: number): string {
  if (!observations.length) return "No observations found for that session.";
  return observations
    .slice(0, limit)
    .map((obs) => {
      const title = obs.title || obs.subtitle || obs.type || "observation";
      const files = Array.isArray(obs.files) && obs.files.length ? ` files=${obs.files.slice(0, 4).join(",")}` : "";
      return `- ${obs.timestamp || ""} ${obs.id || obs.obsId || ""} (${obs.type || "other"}) ${title}${files}${obs.narrative ? `: ${clip(obs.narrative, 700)}` : ""}`.trim();
    })
    .join("\n");
}

function formatTimeline(entries: Array<{ observation?: AgentMemoryObservation; sessionId?: string; relativePosition?: number }>, limit: number): string {
  if (!entries.length) return "No timeline entries found.";
  return entries
    .slice(0, limit)
    .map((entry) => {
      const obs = entry.observation || {};
      const title = obs.title || obs.subtitle || obs.type || "observation";
      return `- ${obs.timestamp || ""} ${obs.id || ""} session=${entry.sessionId || obs.sessionId || ""} ${entry.relativePosition ?? ""} (${obs.type || "other"}) ${title}${obs.narrative ? `: ${clip(obs.narrative, 650)}` : ""}`.trim();
    })
    .join("\n");
}

function formatLessons(lessons: AgentMemoryLesson[]): string {
  if (!lessons.length) return "No matching lessons found.";
  return lessons
    .slice(0, 8)
    .map((lesson) => {
      const confidence = typeof lesson.confidence === "number" ? ` confidence=${lesson.confidence.toFixed(2)}` : "";
      const tags = Array.isArray(lesson.tags) && lesson.tags.length ? ` tags=${lesson.tags.join(",")}` : "";
      return `- ${lesson.id || "lesson"}${confidence}${tags}: ${clip(lesson.content || lesson.context || "", 800)}`;
    })
    .join("\n");
}

async function callAgentMemory<T>(
  pathname: string,
  options?: {
    method?: HttpMethod;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    baseUrl?: string;
  },
): Promise<T | null> {
  const baseUrl = normalizeBaseUrl(options?.baseUrl || process.env.AGENTMEMORY_URL || DEFAULT_URL);
  const method = options?.method || "POST";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options?.query || {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  const url = `${baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {};
  const secret = process.env.AGENTMEMORY_SECRET;
  guardPlaintextBearerAuth(baseUrl, secret);
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLICY.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default function agentmemoryExtension(pi: ExtensionAPI) {
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(
      normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      process.env.AGENTMEMORY_SECRET,
    );
  }
  let sessionId = `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
  let currentProject = process.cwd();
  let lastPrompt = "";
  let lastHealthOk = false;
  let sessionMetricsPersisted = false;
  const metrics = createMetrics();
  const autoCaptureSamples: AutoCaptureMetricSample[] = [];

  async function trackedCall<T>(
    pathname: string,
    options?: {
      method?: HttpMethod;
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      baseUrl?: string;
    },
  ): Promise<T | null> {
    const started = Date.now();
    const result = await callAgentMemory<T>(pathname, options);
    recordEndpointMetric(metrics, pathname, result !== null, Date.now() - started);
    return result;
  }

  function projectPayload(project = currentProject): { project?: string } {
    return POLICY.projectScope ? { project } : {};
  }

  async function searchMemory(
    query: string,
    limit: number,
    options?: { includeLessons?: boolean; source?: string; project?: string },
  ): Promise<SmartSearchResult[]> {
    const result = await trackedCall<{ results?: SmartSearchResult[] }>("smart-search", {
      body: {
        query,
        limit,
        ...projectPayload(options?.project || currentProject),
        sessionId,
        ...(options?.includeLessons !== undefined ? { includeLessons: options.includeLessons } : {}),
        ...(options?.source ? { source: options.source } : {}),
      },
    });
    return result?.results || [];
  }

  async function getHealth() {
    return await trackedCall<HealthResponse>("health", { method: "GET" });
  }

  async function refreshStatus(ctx: { ui: { setStatus: (key: string, text: string) => void } }) {
    const health = await getHealth();
    lastHealthOk = !!health && (health.status === "healthy" || health.health?.status === "healthy");
    ctx.ui.setStatus("agentmemory", lastHealthOk ? "🧠 agentmemory" : "🧠 agentmemory off");
  }

  pi.registerCommand("agentmemory-status", {
    description: "Check local agentmemory server health",
    handler: async (_args, ctx) => {
      const health = await getHealth();
      if (!health) {
        ctx.ui.notify("agentmemory is unreachable at http://localhost:3111", "warning");
        return;
      }
      ctx.ui.notify(
        `agentmemory ${health.status || health.health?.status || "unknown"}${health.version ? ` v${health.version}` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("agentmemory-metrics", {
    description: "Show Pi-side agentmemory integration metrics",
    handler: async (_args, ctx) => {
      const persisted = await readPersistedMetrics();
      ctx.ui.notify(clip([formatMetrics(metrics, "current session metrics"), "", formatPersistedMetricsSummary(persisted)].join("\n"), 3500), "info");
    },
  });

  pi.registerCommand("agentmemory-context", {
    description: "Preview filtered agentmemory recall for a query",
    handler: async (args, ctx) => {
      const query = args.trim() || lastPrompt;
      if (!query) {
        ctx.ui.notify("Usage: /agentmemory-context <query>", "warning");
        return;
      }
      const rawResults = await searchMemory(query, POLICY.recallLimit * 3, { includeLessons: true, source: "pi-context-preview" });
      const { kept, filtered } = filterRecallResults(rawResults, POLICY.recallLimit);
      metrics.recalledItems += rawResults.length;
      metrics.filteredItems += filtered.length;
      const text = [
        `agentmemory recall preview for: ${clip(query, 160)}`,
        `project=${POLICY.projectScope ? currentProject : "all"} kept=${kept.length} filtered=${filtered.length}`,
        "",
        formatSearchResults(kept),
      ].join("\n");
      ctx.ui.notify(clip(text, 1800), "info");
    },
  });

  pi.registerTool({
    name: "memory_health",
    label: "Memory Health",
    description: "Check whether the local agentmemory server is reachable and healthy",
    parameters: Type.Object({}),
    async execute() {
      const health = await getHealth();
      if (!health) {
        return {
          content: [{ type: "text", text: "agentmemory is unreachable at http://localhost:3111" }],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `agentmemory status: ${health.status || health.health?.status || "unknown"}${health.version ? ` (v${health.version})` : ""}`,
          },
        ],
        details: health,
      };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search agentmemory for cross-session project memory, prior decisions, bugs, and user preferences",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in memory" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Maximum results" })),
      project: Type.Optional(Type.String({ description: "Optional project filter; defaults to the current project when project scoping is enabled" })),
    }),
    async execute(_toolCallId, params) {
      const results = await searchMemory(params.query, params.limit ?? 5, { project: params.project, source: "pi-tool-memory-search" });
      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { query: params.query, project: params.project || currentProject, results },
      };
    },
  });

  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description: "Save a durable fact, convention, workflow, preference, or bug fix into agentmemory",
    parameters: Type.Object({
      content: Type.String({ description: "What should be remembered" }),
      type: Type.Optional(
        Type.String({
          description: "Memory type",
          default: "fact",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await trackedCall<Record<string, unknown>>("remember", {
        body: { content: params.content, type: params.type || "fact", project: currentProject },
      });
      if (!result) {
        return {
          content: [{ type: "text", text: "Failed to save memory to agentmemory." }],
          details: { ok: false },
        };
      }
      return {
        content: [{ type: "text", text: `Saved memory (${params.type || "fact"}): ${params.content}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memory_sessions",
    label: "Memory Sessions",
    description: "List recent agentmemory sessions, or show observations for one sessionId",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, default: 10, description: "Maximum sessions or observations" })),
      project: Type.Optional(Type.String({ description: "Optional project/cwd filter; defaults to all projects" })),
      sessionId: Type.Optional(Type.String({ description: "Session ID to inspect; when provided, returns observations for that session" })),
    }),
    async execute(_toolCallId, params) {
      const limit = params.limit ?? 10;
      if (params.sessionId) {
        const result = await trackedCall<{ observations?: AgentMemoryObservation[] }>("observations", {
          method: "GET",
          query: { sessionId: params.sessionId },
        });
        const observations = result?.observations || [];
        return {
          content: [{ type: "text", text: formatObservations(observations, limit) }],
          details: { sessionId: params.sessionId, observations },
        };
      }
      const result = await trackedCall<{ sessions?: AgentMemorySession[] }>("sessions", { method: "GET" });
      const sessions = result?.sessions || [];
      return {
        content: [{ type: "text", text: formatSessions(sessions, limit, params.project) }],
        details: { sessions },
      };
    },
  });

  pi.registerTool({
    name: "memory_file_context",
    label: "Memory File Context",
    description: "Find prior agentmemory observations about specific files",
    parameters: Type.Object({
      files: Type.String({ description: "Comma-separated file paths to look up" }),
      project: Type.Optional(Type.String({ description: "Project path filter; defaults to current cwd" })),
    }),
    async execute(_toolCallId, params) {
      const result = await trackedCall<{ context?: string }>("file-context", {
        body: { files: splitCsv(params.files), sessionId, project: params.project || currentProject },
      });
      const context = result?.context?.trim() || "No prior file context found for those files.";
      return {
        content: [{ type: "text", text: context.length <= 8000 ? context : `${context.slice(0, 8000).trim()}\n…[truncated]` }],
        details: result || { ok: false },
      };
    },
  });

  pi.registerTool({
    name: "memory_timeline",
    label: "Memory Timeline",
    description: "Show chronological agentmemory observations around an ISO date or keyword anchor",
    parameters: Type.Object({
      anchor: Type.String({ description: "Anchor point: ISO date/time or keyword" }),
      project: Type.Optional(Type.String({ description: "Project path filter; defaults to current cwd" })),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 5, description: "Observations before anchor" })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 5, description: "Observations after anchor" })),
    }),
    async execute(_toolCallId, params) {
      const result = await trackedCall<{ entries?: Array<{ observation?: AgentMemoryObservation; sessionId?: string; relativePosition?: number }> }>("timeline", {
        body: { anchor: params.anchor, project: params.project || currentProject, before: params.before ?? 5, after: params.after ?? 5 },
      });
      const entries = result?.entries || [];
      return {
        content: [{ type: "text", text: formatTimeline(entries, (params.before ?? 5) + (params.after ?? 5) + 1) }],
        details: result || { ok: false },
      };
    },
  });

  pi.registerTool({
    name: "memory_profile",
    label: "Memory Profile",
    description: "Show agentmemory's compact profile for the current or specified project",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Project path; defaults to current cwd" })),
    }),
    async execute(_toolCallId, params) {
      const project = params.project || currentProject;
      const result = await trackedCall<Record<string, unknown>>("profile", {
        method: "GET",
        query: { project },
      });
      return {
        content: [{ type: "text", text: result ? jsonPreview(result, 6000) : `No profile found for ${project}.` }],
        details: result || { ok: false, project },
      };
    },
  });

  pi.registerTool({
    name: "memory_lesson_search",
    label: "Memory Lesson Search",
    description: "Search durable lessons learned in agentmemory",
    parameters: Type.Object({
      query: Type.String({ description: "Lesson search query" }),
      project: Type.Optional(Type.String({ description: "Project path filter; defaults to current cwd" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Maximum lessons" })),
      minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum confidence" })),
    }),
    async execute(_toolCallId, params) {
      const result = await trackedCall<{ lessons?: AgentMemoryLesson[] }>("lessons/search", {
        body: { query: params.query, project: params.project || currentProject, limit: params.limit ?? 5, minConfidence: params.minConfidence },
      });
      const lessons = result?.lessons || [];
      return {
        content: [{ type: "text", text: formatLessons(lessons) }],
        details: result || { ok: false },
      };
    },
  });

  pi.registerTool({
    name: "memory_verify",
    label: "Memory Verify",
    description: "Trace provenance for an agentmemory memory or observation ID",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID or observation ID to verify" }),
    }),
    async execute(_toolCallId, params) {
      const result = await trackedCall<Record<string, unknown>>("verify", {
        body: { id: params.id },
      });
      return {
        content: [{ type: "text", text: result ? jsonPreview(result, 6000) : `No provenance found for ${params.id}.` }],
        details: result || { ok: false, id: params.id },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = sessionFile ? path.basename(sessionFile).replace(/\.[^.]+$/, "") : `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
    currentProject = ctx.cwd || process.cwd();
    sessionMetricsPersisted = false;
    await refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    if (!sessionMetricsPersisted) {
      sessionMetricsPersisted = true;
      await persistSessionMetrics({
        sessionId,
        project: currentProject,
        startedAt: metrics.startedAt,
        endedAt: new Date().toISOString(),
        reason: event.reason,
        metrics: cloneMetrics(metrics),
        autoCaptureSamples: autoCaptureSamples.slice(-50),
      });
    }
    if (event.reason === "reload" || !sessionId) return;
    await trackedCall("session/end", {
      body: { sessionId },
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = event.systemPromptOptions.cwd || process.cwd();
    lastPrompt = event.prompt?.trim() || "";
    if (!lastPrompt) return;

    const rawResults = await searchMemory(lastPrompt, POLICY.recallLimit * 3, { includeLessons: true, source: "pi-before-agent-start" });
    const { kept: results, filtered } = filterRecallResults(rawResults, POLICY.recallLimit);
    metrics.recalledItems += rawResults.length;
    metrics.injectedItems += results.length;
    metrics.filteredItems += filtered.length;
    const recallBlock = results.length
      ? [
          "Relevant long-term memory from agentmemory:",
          formatSearchResults(results),
        ].join("\n")
      : "";

    await refreshStatus(ctx);
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE, recallBlock].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("agent_end", async (event) => {
    if (!lastHealthOk || !lastPrompt) return;
    const assistantText = getLastAssistantText(event.messages as unknown[]);
    if (!assistantText) return;

    metrics.autoCapturesConsidered += 1;
    const decision = autoCaptureDecision(lastPrompt, assistantText);
    autoCaptureSamples.push({
      timestamp: new Date().toISOString(),
      sessionId,
      project: currentProject,
      promptPreview: clip(lastPrompt, 160),
      responseChars: assistantText.length,
      capture: decision.capture,
      reason: decision.reason,
    });
    if (autoCaptureSamples.length > 100) autoCaptureSamples.splice(0, autoCaptureSamples.length - 100);
    if (!decision.capture) {
      metrics.autoCapturesSkipped += 1;
      return;
    }

    const result = await trackedCall("observe", {
      body: {
        hookType: "post_tool_use",
        sessionId,
        project: currentProject,
        cwd: currentProject,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "pi_session_outcome",
          tool_input: JSON.stringify({ prompt: lastPrompt.slice(0, 500), capture_reason: decision.reason }),
          tool_output: assistantText.slice(0, 4000),
        },
      },
    });
    if (result) metrics.autoCapturesSaved += 1;
  });
}
