// Ask-several node: one question to several models at once, answers side by side.
//
// Sources:
//   "claude"            your local Claude (subscription; no tools, answer only)
//   "codex"             your local Codex (ChatGPT plan), read-only
//   "<vendor>/<model>"  any OpenRouter model, e.g. "openai/gpt-6.2-sol" (billed to your OpenRouter credit)
import { randomUUID } from "node:crypto";
import { claudeSession } from "./claude.mjs";

export const DEFAULT_MODELS = ["claude", "openai/gpt-6.2-sol", "google/gemini-4-hydrogen"];
const MAX_MODELS = 4;
const MAX_TOKENS = 1500; // per answer: keeps one comparison cheap

export function startCompare({ emit, codex, openRouterKey, cwd }) {
  let catalog = null; // OpenRouter model list, fetched once
  async function models() {
    catalog ??= (await (await fetch("https://openrouter.ai/api/v1/models")).json()).data;
    return catalog;
  }

  async function askOpenRouter(model, question) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${openRouterKey}`, "content-type": "application/json", "x-title": "Trident" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, usage: { include: true }, messages: [{ role: "user", content: question }] }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) throw new Error(String(body.error?.message ?? `HTTP ${r.status}`).slice(0, 200));
    return { text: body.choices?.[0]?.message?.content ?? "", cost: body.usage?.cost };
  }

  async function askClaude(question) {
    const s = claudeSession({ cwd, instructions: "Answer the question directly. Do not use tools.", allowedTools: [], canUseTool: async () => ({ behavior: "deny", message: "Answer without tools." }) });
    try {
      return { text: await s.run(question) };
    } finally {
      s.close();
    }
  }

  async function askCodex(question) {
    const why = codex.unavailableReason();
    if (why) throw new Error(why);
    const t = await codex.thread({ cwd, sandbox: "read-only", onRequest: async () => ({ decision: "decline" }) });
    try {
      return { text: await t.run(question) };
    } finally {
      t.close();
    }
  }

  const label = (m) => (m === "claude" ? "Claude (local)" : m === "codex" ? "Codex (local)" : m);

  // Runs every model in parallel. Each answer appears on screen as soon as it arrives.
  return async function askSeveral(question, wanted = DEFAULT_MODELS) {
    const list = [...new Set(wanted)].slice(0, MAX_MODELS);
    if (list.length < 2) return { error: "Pick at least two models to compare." };
    const remote = list.filter((m) => m.includes("/"));
    if (remote.length && !openRouterKey) return { error: "OpenRouter models need OPENROUTER_API_KEY. Use 'claude' and 'codex', or set the key." };
    if (remote.length) {
      const known = new Set((await models()).map((m) => m.id));
      const missing = remote.filter((m) => !known.has(m));
      if (missing.length) return { error: `OpenRouter has no model ${missing.join(", ")} (renamed or retired). Check the exact name.` };
    }

    const id = randomUUID().slice(0, 8);
    emit({ type: "compare", id, question, columns: list.map((m) => ({ model: m, label: label(m), state: "asking" })) });
    const answers = await Promise.all(
      list.map(async (m) => {
        const started = Date.now();
        try {
          const a = m === "claude" ? await askClaude(question) : m === "codex" ? await askCodex(question) : await askOpenRouter(m, question);
          const col = { model: m, label: label(m), state: "done", text: a.text, cost: a.cost, seconds: Math.round((Date.now() - started) / 1000) };
          emit({ type: "compare-answer", id, ...col });
          return col;
        } catch (err) {
          const col = { model: m, label: label(m), state: "failed", text: err.message };
          emit({ type: "compare-answer", id, ...col });
          return col;
        }
      }),
    );
    const cost = answers.reduce((sum, a) => sum + (a.cost ?? 0), 0);
    return { id, answers, cost };
  };
}
