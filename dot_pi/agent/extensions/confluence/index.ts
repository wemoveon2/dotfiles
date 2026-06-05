import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://nebius.atlassian.net/wiki";
const DEFAULT_PAGE_URL = "https://nebius.atlassian.net/wiki/spaces/NBAI/pages/1374257224/Model+templates";
const DEFAULT_SPACE_KEY = "NBAI";
const DEFAULT_PAGE_ID = "1374257224";

type ConfluencePage = {
	id: string;
	type?: string;
	status?: string;
	title: string;
	space?: { key?: string; name?: string };
	version?: { number?: number; when?: string; by?: { displayName?: string } };
	_links?: { webui?: string; base?: string; tinyui?: string };
	body?: { storage?: { value?: string; representation?: string } };
};

type SearchResult = {
	id: string;
	title: string;
	type?: string;
	space?: { key?: string; name?: string };
	version?: { number?: number; when?: string };
	_links?: { webui?: string; tinyui?: string };
};

function getConfig() {
	const baseUrl = (process.env.CONFLUENCE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
	const email = process.env.CONFLUENCE_EMAIL;
	const apiToken = process.env.CONFLUENCE_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
	const bearerToken = process.env.CONFLUENCE_BEARER_TOKEN;

	let authorization: string | undefined;
	if (bearerToken) {
		authorization = `Bearer ${bearerToken}`;
	} else if (email && apiToken) {
		authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
	} else if (apiToken && process.env.CONFLUENCE_AUTH_MODE === "bearer") {
		authorization = `Bearer ${apiToken}`;
	}

	if (!authorization) {
		throw new Error(
			"Confluence credentials not configured. For Atlassian Cloud set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN before starting pi. Optionally set CONFLUENCE_BASE_URL.",
		);
	}

	return { baseUrl, authorization };
}

function pageIdFromUrl(url?: string): string | undefined {
	if (!url) return undefined;
	const match = url.match(/\/pages\/(\d+)(?:\/|$)/);
	return match?.[1];
}

function webUrl(baseUrl: string, page: ConfluencePage | SearchResult): string {
	const webui = page._links?.webui;
	if (webui) return `${baseUrl}${webui.startsWith("/") ? webui : `/${webui}`}`;
	return `${baseUrl}/pages/${page.id}`;
}

function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, entity: string) => {
		if (entity[0] === "#") {
			const isHex = entity[1]?.toLowerCase() === "x";
			const value = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			return Number.isFinite(value) ? String.fromCodePoint(value) : _m;
		}
		return named[entity] ?? _m;
	});
}

function storageToText(storage: string): string {
	let html = storage;

	// Drop noisy blocks first.
	html = html.replace(/<script[\s\S]*?<\/script>/gi, "\n");
	html = html.replace(/<style[\s\S]*?<\/style>/gi, "\n");
	html = html.replace(/<ac:parameter[^>]*ac:name=["'](?:schema-version|macro-id)["'][\s\S]*?<\/ac:parameter>/gi, "");

	// Preserve useful structure before stripping tags.
	html = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => `\n${"#".repeat(Number(level))} ${body}\n`);
	html = html.replace(/<li[^>]*>/gi, "\n- ");
	html = html.replace(/<\/(p|div|br|tr|ul|ol)>/gi, "\n");
	html = html.replace(/<(td|th)[^>]*>/gi, " | ");
	html = html.replace(/<ac:structured-macro[^>]*ac:name=["']([^"']+)["'][^>]*>/gi, "\n[macro: $1]\n");
	html = html.replace(/<ri:page[^>]*ri:content-title=["']([^"']+)["'][^>]*\/>/gi, "$1");
	html = html.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");

	// Strip remaining tags and normalize whitespace.
	const text = decodeEntities(html.replace(/<[^>]+>/g, " "));
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line, index, lines) => line || lines[index - 1])
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractSections(text: string, query: string | undefined, maxChars: number): string {
	if (!query?.trim()) return text.slice(0, maxChars);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const chunks = text.split(/(?=^#{1,6}\s+)/m);
	const matching = chunks.filter((chunk) => {
		const lower = chunk.toLowerCase();
		return terms.some((term) => lower.includes(term));
	});
	return (matching.length ? matching.join("\n\n---\n\n") : text.slice(0, maxChars)).slice(0, maxChars);
}

async function saveTemp(content: string, prefix = "confluence") {
	const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
	const path = join(dir, "dump.md");
	await writeFile(path, content, "utf8");
	return path;
}

async function confluenceFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
	const { baseUrl, authorization } = getConfig();
	const response = await fetch(`${baseUrl}${path}`, {
		headers: {
			Authorization: authorization,
			Accept: "application/json",
		},
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Confluence API ${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
	}
	return (await response.json()) as T;
}

async function getPage(pageId: string, signal?: AbortSignal): Promise<ConfluencePage> {
	return confluenceFetch<ConfluencePage>(
		`/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`,
		signal,
	);
}

async function getChildren(pageId: string, limit: number, signal?: AbortSignal): Promise<ConfluencePage[]> {
	const response = await confluenceFetch<{ results?: ConfluencePage[] }>(
		`/rest/api/content/${encodeURIComponent(pageId)}/child/page?limit=${limit}&expand=version,space`,
		signal,
	);
	return response.results ?? [];
}

function formatPage(page: ConfluencePage, baseUrl: string, body: string) {
	const version = page.version?.number ? ` v${page.version.number}` : "";
	const space = page.space?.key ? ` [${page.space.key}]` : "";
	return `# ${page.title}${space}${version}\n\nURL: ${webUrl(baseUrl, page)}\nPage ID: ${page.id}\n\n${body}`.trim();
}

function cqlEscape(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export default function confluenceExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "confluence_search",
		label: "Confluence Search",
		description: "Read-only search for Nebius Confluence pages. Uses CQL and returns compact page references.",
		promptSnippet: "Search Nebius Confluence pages by text/CQL and return compact page references",
		promptGuidelines: [
			"Use confluence_search before fetching Confluence pages when you need to discover relevant docs without spending many tokens.",
			"Use confluence_read_page for targeted Confluence page reads and confluence_dump_page when the user explicitly asks for brute-force/full context.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search text. Ignored if rawCql is provided." }),
			spaceKey: Type.Optional(Type.String({ description: "Confluence space key. Defaults to NBAI." })),
			rawCql: Type.Optional(Type.String({ description: "Optional raw Confluence CQL. Use only when needed." })),
			limit: Type.Optional(Type.Number({ description: "Max results, default 10, max 25." })),
		}),
		async execute(_toolCallId, params, signal) {
			const { baseUrl } = getConfig();
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 10), 1), 25);
			const spaceKey = params.spaceKey || DEFAULT_SPACE_KEY;
			const cql = params.rawCql?.trim() || `space = "${cqlEscape(spaceKey)}" AND type = page AND text ~ "${cqlEscape(params.query)}" ORDER BY lastmodified DESC`;
			const data = await confluenceFetch<{ results?: SearchResult[] }>(
				`/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,version`,
				signal,
			);
			const results = data.results ?? [];
			const text = results.length
				? results
						.map((page, index) => `${index + 1}. ${page.title} [${page.space?.key ?? "?"}]\n   id: ${page.id}\n   url: ${webUrl(baseUrl, page)}\n   updated: ${page.version?.when ?? "unknown"}`)
						.join("\n")
				: `No Confluence pages found for CQL: ${cql}`;
			return {
				content: [{ type: "text", text: `CQL: ${cql}\n\n${text}` }],
				details: { cql, count: results.length, results: results.map((page) => ({ id: page.id, title: page.title, url: webUrl(baseUrl, page), spaceKey: page.space?.key })) },
			};
		},
	});

	pi.registerTool({
		name: "confluence_read_page",
		label: "Confluence Read Page",
		description: "Read a Confluence page in token-efficient form. Defaults to the Model templates page. Can return summary-sized text, headings, or matching sections.",
		promptSnippet: "Read a targeted Confluence page efficiently by id/URL, optionally extracting matching sections",
		promptGuidelines: [
			"Use confluence_read_page for normal Confluence access because it limits output and can extract only relevant sections.",
			"Use confluence_read_page with sectionQuery when the user asks about a specific part of a long Confluence page.",
		],
		parameters: Type.Object({
			pageId: Type.Optional(Type.String({ description: "Confluence page ID. Defaults to 1374257224." })),
			url: Type.Optional(Type.String({ description: "Confluence page URL. Used to extract page ID if pageId is omitted." })),
			mode: Type.Optional(StringEnum(["efficient", "headings", "sections", "full-preview"] as const, { description: "efficient returns the first part; headings returns only headings; sections extracts parts matching sectionQuery; full-preview returns a larger preview." })),
			sectionQuery: Type.Optional(Type.String({ description: "Terms used to extract relevant sections in sections mode." })),
			maxChars: Type.Optional(Type.Number({ description: "Output character budget. Defaults 12000; max 50000." })),
		}),
		async execute(_toolCallId, params, signal) {
			const { baseUrl } = getConfig();
			const pageId = params.pageId || pageIdFromUrl(params.url) || DEFAULT_PAGE_ID;
			const mode = params.mode || "efficient";
			const maxChars = Math.min(Math.max(Math.floor(params.maxChars ?? (mode === "full-preview" ? 30000 : 12000)), 1000), 50000);
			const page = await getPage(pageId, signal);
			const fullText = storageToText(page.body?.storage?.value ?? "");

			let body: string;
			if (mode === "headings") {
				body = fullText.split("\n").filter((line) => /^#{1,6}\s+/.test(line)).join("\n") || "No headings found.";
			} else if (mode === "sections") {
				body = extractSections(fullText, params.sectionQuery, maxChars);
			} else {
				body = fullText.slice(0, maxChars);
			}

			const formatted = formatPage(page, baseUrl, body);
			const omitted = fullText.length > body.length;
			return {
				content: [{ type: "text", text: `${formatted}${omitted ? `\n\n[Token-efficient read: returned ${body.length} of ${fullText.length} chars. Use confluence_dump_page for brute-force/full context.]` : ""}` }],
				details: { pageId: page.id, title: page.title, url: webUrl(baseUrl, page), mode, returnedChars: body.length, fullChars: fullText.length },
			};
		},
	});

	pi.registerTool({
		name: "confluence_list_children",
		label: "Confluence Children",
		description: "List child pages under a Confluence page without fetching their bodies. Read-only and token efficient.",
		promptSnippet: "List Confluence child pages under a parent page",
		parameters: Type.Object({
			pageId: Type.Optional(Type.String({ description: "Parent page ID. Defaults to 1374257224." })),
			url: Type.Optional(Type.String({ description: "Parent page URL. Used to extract page ID if pageId is omitted." })),
			limit: Type.Optional(Type.Number({ description: "Max children, default 25, max 100." })),
		}),
		async execute(_toolCallId, params, signal) {
			const { baseUrl } = getConfig();
			const pageId = params.pageId || pageIdFromUrl(params.url) || DEFAULT_PAGE_ID;
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 25), 1), 100);
			const children = await getChildren(pageId, limit, signal);
			const text = children.length
				? children.map((page, index) => `${index + 1}. ${page.title}\n   id: ${page.id}\n   url: ${webUrl(baseUrl, page)}\n   updated: ${page.version?.when ?? "unknown"}`).join("\n")
				: "No child pages found.";
			return {
				content: [{ type: "text", text }],
				details: { parentId: pageId, count: children.length, children: children.map((page) => ({ id: page.id, title: page.title, url: webUrl(baseUrl, page) })) },
			};
		},
	});

	pi.registerTool({
		name: "confluence_dump_page",
		label: "Confluence Dump Page",
		description: "Brute-force read of a Confluence page, optionally including child pages recursively. Saves the full dump to a temp Markdown file and returns a truncated preview.",
		promptSnippet: "Brute-force dump a Confluence page and optional child pages to a temp Markdown file",
		promptGuidelines: [
			"Use confluence_dump_page only when the user asks for full/brute-force Confluence context or when targeted reads were insufficient.",
			"Prefer confluence_read_page or confluence_search for Confluence access when token efficiency matters.",
		],
		parameters: Type.Object({
			pageId: Type.Optional(Type.String({ description: "Root page ID. Defaults to 1374257224." })),
			url: Type.Optional(Type.String({ description: "Root page URL. Used to extract page ID if pageId is omitted." })),
			includeChildren: Type.Optional(Type.Boolean({ description: "Include child pages recursively. Default false." })),
			depth: Type.Optional(Type.Number({ description: "Child recursion depth when includeChildren is true. Default 1, max 3." })),
			maxPages: Type.Optional(Type.Number({ description: "Maximum pages to dump including root. Default 25, max 100." })),
			previewChars: Type.Optional(Type.Number({ description: "Preview character budget returned to the model. Default 45000, max 50000." })),
		}),
		async execute(_toolCallId, params, signal) {
			const { baseUrl } = getConfig();
			const rootId = params.pageId || pageIdFromUrl(params.url) || DEFAULT_PAGE_ID;
			const includeChildren = params.includeChildren ?? false;
			const maxDepth = Math.min(Math.max(Math.floor(params.depth ?? 1), 0), 3);
			const maxPages = Math.min(Math.max(Math.floor(params.maxPages ?? 25), 1), 100);
			const previewChars = Math.min(Math.max(Math.floor(params.previewChars ?? 45000), 1000), 50000);

			const pages: ConfluencePage[] = [];
			const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
			const seen = new Set<string>();

			while (queue.length && pages.length < maxPages) {
				const current = queue.shift()!;
				if (seen.has(current.id)) continue;
				seen.add(current.id);
				const page = await getPage(current.id, signal);
				pages.push(page);
				if (includeChildren && current.depth < maxDepth && pages.length < maxPages) {
					const children = await getChildren(current.id, Math.min(100, maxPages - pages.length), signal);
					for (const child of children) queue.push({ id: child.id, depth: current.depth + 1 });
				}
			}

			const dump = pages
				.map((page) => formatPage(page, baseUrl, storageToText(page.body?.storage?.value ?? "")))
				.join("\n\n---\n\n");
			const tempPath = await saveTemp(dump);
			const truncation = truncateHead(dump, {
				maxBytes: Math.min(DEFAULT_MAX_BYTES, previewChars),
				maxLines: DEFAULT_MAX_LINES,
			});
			const preview = truncation.content.slice(0, previewChars);
			const truncated = truncation.truncated || dump.length > preview.length;
			const note = truncated
				? `\n\n[Full Confluence dump saved to: ${tempPath}. Preview truncated to ${formatSize(Buffer.byteLength(preview))} of ${formatSize(Buffer.byteLength(dump))}. Use the read tool on that temp file if you need more.]`
				: `\n\n[Full Confluence dump also saved to: ${tempPath}.]`;

			return {
				content: [{ type: "text", text: `${preview}${note}` }],
				details: { rootId, pageCount: pages.length, tempPath, truncated, bytes: Buffer.byteLength(dump), pages: pages.map((page) => ({ id: page.id, title: page.title, url: webUrl(baseUrl, page) })) },
			};
		},
	});

	pi.registerCommand("confluence-help", {
		description: "Show Confluence extension setup and tools",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Confluence tools loaded. Default page: ${DEFAULT_PAGE_URL}\nSet CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN before starting pi. Tools: confluence_search, confluence_read_page, confluence_list_children, confluence_dump_page.`,
				"info",
			);
		},
	});
}
