import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_DETAILS_CHARS = 200_000;
const MAX_CONTENT_CHARS = 40_000;
const MCP_TIMEOUT_MS = 180_000;
const CLI_TIMEOUT_MS = 300_000;

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; details?: Record<string, unknown>; isError?: boolean };

const projectPathProperty = Type.Optional(
	Type.String({
		description:
			"Path to a different project with .codegraph/ initialized. If omitted, uses the current pi working directory.",
	}),
);

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function stringEnum<const T extends readonly string[]>(values: T, options?: Record<string, unknown>) {
	return Type.Union(values.map((value) => Type.Literal(value)) as any, options as any);
}

function normalizeProjectPath<T extends { projectPath?: string }>(cwd: string, params: T): T {
	if (!params.projectPath || path.isAbsolute(params.projectPath)) return params;
	return { ...params, projectPath: path.resolve(cwd, params.projectPath) };
}

function textFromMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
				return String((item as { text?: unknown }).text ?? "");
			}
			return JSON.stringify(item);
		})
		.filter(Boolean)
		.join("\n");
}

async function callCodegraphMcp(toolName: string, toolArgs: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdoutBuffer = "";
		let stderr = "";

		const child = spawn("codegraph", ["serve", "--mcp", "--path", cwd], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		const cleanup = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", abortHandler);
		};

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				child.stdin.end();
			} catch {
				/* ignore */
			}
			if (!child.killed) child.kill("SIGTERM");
			fn();
		};

		const fail = (message: string) => {
			finish(() => reject(new Error(message)));
		};

		const send = (message: unknown) => {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		};

		const timer = setTimeout(() => {
			fail(`codegraph ${toolName} timed out after ${MCP_TIMEOUT_MS / 1000}s`);
		}, MCP_TIMEOUT_MS);

		const abortHandler = () => fail(`codegraph ${toolName} aborted`);
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}

		child.on("error", (err) => {
			fail(`Unable to start codegraph. Is it installed and on PATH? ${err.message}`);
		});

		child.stderr.on("data", (data) => {
			stderr = truncate(stderr + data.toString(), MAX_DETAILS_CHARS);
		});

		child.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}

				if (msg.id === 1) {
					if (msg.error) {
						fail(`codegraph initialize failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
						return;
					}
					send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: toolArgs } });
					return;
				}

				if (msg.id === 2) {
					if (msg.error) {
						fail(`codegraph ${toolName} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
						return;
					}
					const result = msg.result ?? {};
					const contentText = textFromMcpContent(result.content);
					const content = result.content && Array.isArray(result.content)
						? result.content.map((item: any) => ({ type: "text", text: truncate(String(item.text ?? JSON.stringify(item)), MAX_CONTENT_CHARS) }))
						: [{ type: "text", text: truncate(contentText || JSON.stringify(result), MAX_CONTENT_CHARS) }];
					finish(() =>
						resolve({
							content,
							isError: Boolean(result.isError),
							details: {
								tool: toolName,
								args: toolArgs,
								stderr: stderr || undefined,
								result,
							},
						}),
					);
				}
			}
		});

		child.on("close", (code) => {
			if (!settled) {
				fail(`codegraph ${toolName} exited before responding (code ${code ?? "unknown"}).${stderr ? `\n${stderr}` : ""}`);
			}
		});

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-codegraph", version: "1.0.0" },
			},
		});
	});
}

async function runCodegraphCli(args: string[], cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn("codegraph", args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });

		const finish = (code: number | null, killed = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", abortHandler);
			const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
			resolve({
				content: [{ type: "text", text: truncate(output || `(codegraph exited with code ${code ?? "unknown"})`, MAX_CONTENT_CHARS) }],
				isError: killed || (code ?? 1) !== 0,
				details: { args, exitCode: code, stdout: truncate(stdout, MAX_DETAILS_CHARS), stderr: truncate(stderr, MAX_DETAILS_CHARS) },
			});
		};

		const timer = setTimeout(() => {
			if (!child.killed) child.kill("SIGTERM");
			finish(null, true);
		}, CLI_TIMEOUT_MS);

		const abortHandler = () => {
			if (!child.killed) child.kill("SIGTERM");
			finish(null, true);
		};
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}

		child.stdout.on("data", (data) => {
			stdout = truncate(stdout + data.toString(), MAX_DETAILS_CHARS);
		});
		child.stderr.on("data", (data) => {
			stderr = truncate(stderr + data.toString(), MAX_DETAILS_CHARS);
		});
		child.on("error", (err) => {
			stderr += `\nUnable to start codegraph. Is it installed and on PATH? ${err.message}`;
			finish(1);
		});
		child.on("close", (code) => finish(code));
	});
}

const searchParams = Type.Object({
	query: Type.String({ description: 'Symbol name or partial name, e.g. "auth", "signIn", "UserService".' }),
	kind: Type.Optional(
		stringEnum(["function", "method", "class", "interface", "type", "variable", "route", "component"] as const, {
			description: "Filter by node kind.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum results. Default: 10.", default: 10 })),
	projectPath: projectPathProperty,
});

const symbolLimitParams = Type.Object({
	symbol: Type.String({ description: "Name of the function, method, or class." }),
	limit: Type.Optional(Type.Number({ description: "Maximum results. Default: 20.", default: 20 })),
	projectPath: projectPathProperty,
});

const impactParams = Type.Object({
	symbol: Type.String({ description: "Name of the symbol to analyze impact for." }),
	depth: Type.Optional(Type.Number({ description: "Dependency traversal depth. Default: 2.", default: 2 })),
	projectPath: projectPathProperty,
});

const nodeParams = Type.Object({
	symbol: Type.String({ description: "Name of the symbol to get details for." }),
	includeCode: Type.Optional(Type.Boolean({ description: "Include full source code. Default: false.", default: false })),
	file: Type.Optional(Type.String({ description: "Optional file path or basename to disambiguate overloaded names." })),
	line: Type.Optional(Type.Number({ description: "Optional line number to disambiguate overloaded names." })),
	projectPath: projectPathProperty,
});

const exploreParams = Type.Object({
	query: Type.String({
		description:
			'Natural-language question or a bag of symbol/file names, e.g. "AuthService loginUser session-manager".',
	}),
	maxFiles: Type.Optional(Type.Number({ description: "Maximum files to include source from. Default is adaptive.", default: 12 })),
	projectPath: projectPathProperty,
});

const statusParams = Type.Object({ projectPath: projectPathProperty });

const filesParams = Type.Object({
	path: Type.Optional(Type.String({ description: 'Filter to files under this directory, e.g. "src/components".' })),
	pattern: Type.Optional(Type.String({ description: 'Filter files matching this glob, e.g. "*.tsx" or "**/*.test.ts".' })),
	format: Type.Optional(stringEnum(["tree", "flat", "grouped"] as const, { description: "Output format.", default: "tree" })),
	includeMetadata: Type.Optional(Type.Boolean({ description: "Include language and symbol counts. Default: true.", default: true })),
	maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth for tree format." })),
	projectPath: projectPathProperty,
});

const initParams = Type.Object({
	projectPath: Type.Optional(Type.String({ description: "Project directory to initialize/index. Defaults to pi's current working directory." })),
});

function registerMcpTool(pi: ExtensionAPI, name: string, label: string, description: string, promptSnippet: string, parameters: any) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet,
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				return await callCodegraphMcp(name, normalizeProjectPath(ctx.cwd, params as Record<string, unknown>), ctx.cwd, signal);
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
					details: { tool: name, args: params },
				};
			}
		},
	});
}

const codegraphGuidelines = [
	"Use codegraph_explore first for structural questions, architecture, flows, bugs, where/what-is-X, and codebase-area surveys; it returns source grouped by file and is usually the only CodeGraph call needed.",
	"Trust CodeGraph results as AST/index-backed. Do not re-verify shown CodeGraph source with grep/read unless a specific detail is missing or a staleness warning names a file.",
	"If a CodeGraph tool says the project is not initialized, use codegraph_init (or bash: codegraph init -i) for that project before retrying.",
	"Use codegraph_impact before refactors, codegraph_callers/callees for focused call graph questions, codegraph_node for one exact symbol body, and codegraph_files for indexed layout.",
];

export default async function (pi: ExtensionAPI) {
	const version = await pi.exec("codegraph", ["--version"], { timeout: 5_000 });
	if (version.code !== 0) {
		console.warn("[codegraph] codegraph binary not found in PATH — CodeGraph tools disabled");
		return;
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("codegraph", `CodeGraph ${version.stdout.trim() || "installed"}`);
	});

	registerMcpTool(
		pi,
		"codegraph_search",
		"CodeGraph Search",
		"Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get actual source or understand an area in one call.",
		"Search CodeGraph's symbol index by name and return matching locations.",
		searchParams,
	);

	registerMcpTool(
		pi,
		"codegraph_callers",
		"CodeGraph Callers",
		"List functions that call a symbol. For full flows, prefer codegraph_explore.",
		"Find callers of a symbol in the CodeGraph call graph.",
		symbolLimitParams,
	);

	registerMcpTool(
		pi,
		"codegraph_callees",
		"CodeGraph Callees",
		"List functions that a symbol calls. For full flows, prefer codegraph_explore.",
		"Find callees of a symbol in the CodeGraph call graph.",
		symbolLimitParams,
	);

	registerMcpTool(
		pi,
		"codegraph_impact",
		"CodeGraph Impact",
		"Analyze symbols affected by changing a symbol. Use before refactors.",
		"Analyze the blast radius of changing a symbol using CodeGraph.",
		impactParams,
	);

	registerMcpTool(
		pi,
		"codegraph_node",
		"CodeGraph Node",
		"Get one symbol's details, signature, callers/callees trail, and optionally full source. Useful when codegraph_explore trimmed a body or a name is overloaded.",
		"Fetch details and optional full source for one CodeGraph symbol.",
		nodeParams,
	);

	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"PRIMARY TOOL — call FIRST for almost any codebase question: how X works, architecture, bugs, where/what is X, flows, or surveying an area. Returns verbatim source of relevant symbols grouped by file in one capped call.",
		promptSnippet: "Explore code semantically with CodeGraph and return relevant source grouped by file.",
		promptGuidelines: codegraphGuidelines,
		parameters: exploreParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				return await callCodegraphMcp("codegraph_explore", normalizeProjectPath(ctx.cwd, params as Record<string, unknown>), ctx.cwd, signal);
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
					details: { tool: "codegraph_explore", args: params },
				};
			}
		},
	});

	registerMcpTool(
		pi,
		"codegraph_status",
		"CodeGraph Status",
		"Check index health, file/node/edge counts, and pending sync status.",
		"Check CodeGraph index health and statistics.",
		statusParams,
	);

	registerMcpTool(
		pi,
		"codegraph_files",
		"CodeGraph Files",
		"Show indexed file tree with language and symbol counts. Faster than filesystem scanning for project layout.",
		"Show indexed project file structure from CodeGraph.",
		filesParams,
	);

	pi.registerTool({
		name: "codegraph_init",
		label: "CodeGraph Init",
		description: "Initialize and index CodeGraph for a project directory by running `codegraph init`.",
		promptSnippet: "Initialize and index a project for CodeGraph when .codegraph is missing.",
		parameters: initParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const projectPath = path.resolve(ctx.cwd, params.projectPath ?? ctx.cwd);
			return await runCodegraphCli(["init", projectPath], projectPath, signal);
		},
	});

	pi.registerCommand("codegraph-init", {
		description: "Initialize and index CodeGraph for the current project (or pass a path).",
		handler: async (args, ctx) => {
			const projectPath = path.resolve(ctx.cwd, args.trim() || ctx.cwd);
			ctx.ui.notify(`Running codegraph init ${projectPath}...`, "info");
			const result = await runCodegraphCli(["init", projectPath], projectPath);
			ctx.ui.notify(result.isError ? "CodeGraph init failed" : "CodeGraph init complete", result.isError ? "error" : "success");
		},
	});
}
