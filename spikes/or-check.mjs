// Free check of the saved OpenRouter key and model: key-info and model catalog only, nothing generated.
const { openRouterConfig } = await import("../src/openrouter.mjs");
const cfg = openRouterConfig();
if (!cfg) { console.log("No OPENROUTER_API_KEY found (process or Windows user environment)."); process.exit(1); }
console.log("model:", cfg.model);
console.log("check:", (await cfg.check()) ?? "OK (key accepted, model exists and can use tools)");
const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${cfg.env.ANTHROPIC_AUTH_TOKEN}` } });
if (r.ok) {
  const { data } = await r.json();
  console.log("free tier:", data.is_free_tier, "| limit:", data.limit ?? "none", "| remaining:", data.limit_remaining ?? "n/a", "| used so far: $" + (data.usage ?? 0));
}
