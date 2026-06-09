import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import crypto from "node:crypto";
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

function formatSearchResults(results: SmartSearchResult[]): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const obs = result.observation ?? result;
      const title = obs.title?.trim() || `Memory ${index + 1}`;
      const narrative = obs.narrative?.trim() || "";
      const type = obs.type?.trim() || "memory";
      const score = result.combinedScore ?? result.score;
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

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
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

  async function getHealth() {
    return await callAgentMemory<HealthResponse>("health", { method: "GET" });
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
    }),
    async execute(_toolCallId, params) {
      const result = await callAgentMemory<{ results?: SmartSearchResult[] }>("smart-search", {
        body: { query: params.query, limit: params.limit ?? 5 },
      });
      const results = result?.results || [];
      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { query: params.query, results },
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
      const result = await callAgentMemory<Record<string, unknown>>("remember", {
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
        const result = await callAgentMemory<{ observations?: AgentMemoryObservation[] }>("observations", {
          method: "GET",
          query: { sessionId: params.sessionId },
        });
        const observations = result?.observations || [];
        return {
          content: [{ type: "text", text: formatObservations(observations, limit) }],
          details: { sessionId: params.sessionId, observations },
        };
      }
      const result = await callAgentMemory<{ sessions?: AgentMemorySession[] }>("sessions", { method: "GET" });
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
      const result = await callAgentMemory<{ context?: string }>("file-context", {
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
      const result = await callAgentMemory<{ entries?: Array<{ observation?: AgentMemoryObservation; sessionId?: string; relativePosition?: number }> }>("timeline", {
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
      const result = await callAgentMemory<Record<string, unknown>>("profile", {
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
      const result = await callAgentMemory<{ lessons?: AgentMemoryLesson[] }>("lessons/search", {
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
      const result = await callAgentMemory<Record<string, unknown>>("verify", {
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
    currentProject = process.cwd();
    await refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload" || !sessionId) return;
    await callAgentMemory("session/end", {
      body: { sessionId },
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = event.systemPromptOptions.cwd || process.cwd();
    lastPrompt = event.prompt?.trim() || "";
    if (!lastPrompt) return;

    const result = await callAgentMemory<{ results?: SmartSearchResult[] }>("smart-search", {
      body: { query: lastPrompt, limit: 5 },
    });
    const results = result?.results || [];
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
    void callAgentMemory("observe", {
      body: {
        hookType: "post_tool_use",
        sessionId,
        project: currentProject,
        cwd: currentProject,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "conversation",
          tool_input: lastPrompt.slice(0, 500),
          tool_output: assistantText.slice(0, 4000),
        },
      },
    });
  });
}
