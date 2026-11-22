// Checks the OpenRouter route with a fake key: the key check and a worker turn should both be refused by OpenRouter.
// Costs nothing (an invalid key cannot generate). Usage: node spikes/or-route.mjs
process.env.OPENROUTER_API_KEY = "sk-or-v1-invalid-trident-test";
const { openRouterConfig } = await import("../src/openrouter.mjs");
const { claudeSession } = await import("../src/claude.mjs");
const cfg = openRouterConfig();
console.log("model:", cfg.model);
console.log("key check:", await cfg.check());
const s = claudeSession({ cwd: process.cwd(), instructions: "test", allowedTools: [], model: cfg.model, env: cfg.env, canUseTool: async () => ({ behavior: "deny", message: "no" }) });
const t = Date.now();
try {
  console.log("turn result:", (await Promise.race([s.run("Reply with ok."), new Promise((_, r) => setTimeout(() => r(new Error("no answer in 90s")), 90000))])).slice(0, 300));
} catch (e) {
  console.log("turn error:", String(e.message).slice(0, 300));
}
console.log("took", Date.now() - t, "ms");
s.close();
process.exit(0);
