import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MUTATING_BASH_PATTERN = /(^|[;&|\n])\s*(cat\s*>|tee\b|mv\b|cp\b|rm\b|mkdir\b|rmdir\b|touch\b|chmod\b|chown\b|git\s+(apply|checkout|merge|rebase|reset|restore|stash\s+apply|commit|add)\b|npm\s+(install|i|update|remove|uninstall)\b|pnpm\s+(install|add|update|remove)\b|yarn\s+(add|install|remove|upgrade)\b|python\s+.*\bsetup\.py\s+install\b)/;
const REDIRECT_PATTERN = /(^|[^>])>(?!>?)|>>/;

function mightMutateViaBash(command: string): boolean {
	return MUTATING_BASH_PATTERN.test(command) || REDIRECT_PATTERN.test(command);
}

export default function autoReview(pi: ExtensionAPI) {
	let sawPotentialFileChange = false;
	let lastRequestedReviewHash: string | undefined;

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			sawPotentialFileChange = true;
			return;
		}

		if (event.toolName === "bash") {
			const command = typeof event.input?.command === "string" ? event.input.command : "";
			if (mightMutateViaBash(command)) sawPotentialFileChange = true;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!sawPotentialFileChange) return;
		sawPotentialFileChange = false;

		const { stdout: repoRoot, code: repoCode } = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
		});
		if (repoCode !== 0) return;

		const cwd = repoRoot.trim() || ctx.cwd;
		const { stdout: status, code: statusCode } = await pi.exec("git", ["status", "--porcelain=v1"], { cwd });
		if (statusCode !== 0 || status.trim().length === 0) return;

		const [unstaged, staged] = await Promise.all([
			pi.exec("git", ["diff", "--binary"], { cwd }),
			pi.exec("git", ["diff", "--cached", "--binary"], { cwd }),
		]);

		const reviewHash = createHash("sha256")
			.update(status)
			.update("\n--- unstaged ---\n")
			.update(unstaged.stdout ?? "")
			.update("\n--- staged ---\n")
			.update(staged.stdout ?? "")
			.digest("hex");

		if (reviewHash === lastRequestedReviewHash) return;
		lastRequestedReviewHash = reviewHash;

		if (ctx.hasUI) {
			ctx.ui.notify("File changes detected; queuing reviewer subagent.", "info");
		}

		pi.sendUserMessage(
			[
				"Use the subagent tool with agent `reviewer` to review the current uncommitted changes.",
				"Review `git status --porcelain`, `git diff --cached`, and `git diff`.",
				"If there are untracked files, read the relevant files directly.",
				"Report only review findings; do not modify files.",
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	});
}
