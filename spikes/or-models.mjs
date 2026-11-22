// Lists OpenRouter models that support tools (public catalog, no key needed, nothing generated).
const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
const price = (x) => `in $${(+x.pricing.prompt * 1e6).toFixed(2)}/M, out $${(+x.pricing.completion * 1e6).toFixed(2)}/M`;
for (const id of process.argv.slice(2)) {
  const x = data.find((y) => y.id === id);
  console.log(id, x ? `${price(x)} tools=${(x.supported_parameters ?? []).includes("tools")}` : "not listed (renamed or retired)");
}
console.log("--- newest tool-capable coding models");
data
  .filter((x) => /coder|kimi|glm|deepseek|qwen3|devstral|gemini|gpt/.test(x.id) && (x.supported_parameters ?? []).includes("tools") && !x.id.includes(":free"))
  .sort((a, b) => b.created - a.created)
  .slice(0, 15)
  .forEach((x) => console.log(x.id, new Date(x.created * 1000).toISOString().slice(0, 10), price(x)));
