import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "total-cost";
const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");

type Totals = {
  cost: number;
  messages: number;
  files: number;
};

function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile() && full.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }

  return out;
}

function readPersistedTotals(): Totals {
  const totals: Totals = { cost: 0, messages: 0, files: 0 };

  for (const file of sessionFiles(SESSION_ROOT)) {
    totals.files++;

    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || entry.message?.role !== "assistant") continue;

        const cost = Number(entry.message.usage?.cost?.total ?? 0);
        if (Number.isFinite(cost)) {
          totals.cost += cost;
          totals.messages++;
        }
      } catch {
        // Ignore partially-written/corrupt lines.
      }
    }
  }

  return totals;
}

function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`;
  if (cost >= 10) return `$${cost.toFixed(1)}`;
  return `$${cost.toFixed(2)}`;
}

function setStatus(ctx: ExtensionContext, totals: Totals) {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `total ${formatCost(totals.cost)}`));
}

export default function (pi: ExtensionAPI) {
  let totals: Totals = { cost: 0, messages: 0, files: 0 };

  const refresh = (ctx: ExtensionContext) => {
    totals = readPersistedTotals();
    setStatus(ctx, totals);
  };

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const message = event.message as AssistantMessage;
    const cost = Number(message.usage?.cost?.total ?? 0);
    if (Number.isFinite(cost) && cost > 0) {
      totals.cost += cost;
      totals.messages++;
      setStatus(ctx, totals);
    }
  });

  pi.registerCommand("total-cost", {
    description: "Refresh and show total cost across saved pi sessions",
    handler: async (_args, ctx) => {
      refresh(ctx);
      ctx.ui.notify(
        `Total pi cost: ${formatCost(totals.cost)} across ${totals.messages} assistant messages in ${totals.files} session files`,
        "info",
      );
    },
  });
}
