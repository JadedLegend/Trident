// The approval gate. An agent's risky tool call waits here until the user answers.
// Choices follow Band's model: allow once, deny, always allow, always deny.
// "Always" answers cover exactly one operation (tool + its exact command/path), never a whole tool.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { summarize } from "./lead.mjs";

export function createGate({ rulesFile, emit }) {
  let rules = { allow: [], deny: [] };
  try {
    rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  } catch {}
  const save = () => {
    mkdirSync(dirname(rulesFile), { recursive: true });
    writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
  };

  const pending = new Map();
  const keyOf = (toolName, input) => `${toolName}: ${summarize(toolName, input)}`;

  // `wp` is the workplace asking, so the screen can show which workplace is waiting.
  function request({ wp, agent, toolName, input, signal }) {
    const key = keyOf(toolName, input);
    if (rules.deny.includes(key)) return Promise.resolve({ behavior: "deny", message: "The user always denies this operation." });
    if (rules.allow.includes(key)) return Promise.resolve({ behavior: "allow", updatedInput: input });

    const id = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      pending.set(id, { resolve, input, key, agent, toolName, wp });
      emit({ type: "approval", wp, id, agent, toolName, summary: summarize(toolName, input), input });
      signal?.addEventListener("abort", () => {
        if (pending.delete(id)) {
          emit({ type: "approval-closed", wp, id, decision: "cancelled" });
          resolve({ behavior: "deny", message: "Cancelled." });
        }
      });
    });
  }

  // decision: "allow" | "deny" | "always-allow" | "always-deny"
  function decide(id, decision) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    if (decision === "always-allow") rules.allow.push(p.key), save();
    if (decision === "always-deny") rules.deny.push(p.key), save();
    const allowed = decision === "allow" || decision === "always-allow";
    p.resolve(allowed ? { behavior: "allow", updatedInput: p.input } : { behavior: "deny", message: "The user denied this." });
    emit({ type: "approval-closed", wp: p.wp, id, decision });
    return true;
  }

  const open = () => [...pending.entries()].map(([id, p]) => ({ type: "approval", id, agent: p.agent, toolName: p.toolName, summary: summarize(p.toolName, p.input), input: p.input }));

  return { request, decide, open };
}
