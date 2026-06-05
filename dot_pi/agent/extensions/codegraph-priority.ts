import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEGRAPH_GUIDANCE = `
CodeGraph priority for code exploration:
- For codebase exploration questions (architecture, flows, where something is implemented, endpoint/service ownership, callers/callees, bugs, or refactors), try CodeGraph before text search or broad filesystem scans.
- In monorepos, never point CodeGraph at the whole repository unless the user explicitly asks for a repo-wide survey. First identify the smallest relevant subtree and pass projectPath for that subtree; initialize that subtree's .codegraph only if needed.
- Prefer codegraph_explore for broad understanding, codegraph_search/node for specific symbols, and codegraph_callers/callees/impact for relationship questions.
- If a CodeGraph call times out or the index is too broad, retry with a narrower projectPath/query before falling back to grep/read.
- Use bash/git grep only after CodeGraph is unavailable, stale, too slow after narrowing, or when the task is plain file/text search rather than code understanding.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (event.systemPrompt.includes("CodeGraph priority for code exploration:")) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n${CODEGRAPH_GUIDANCE}`,
		};
	});
}
