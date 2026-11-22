// Spike: confirm the Claude Agent SDK runs with the existing Claude Code login.
import { query } from "@anthropic-ai/claude-agent-sdk";

const started = Date.now();
for await (const msg of query({
  prompt: "Reply with exactly the word: pong",
  // Isolate from the user's global Claude Code settings (plugins, hooks, MCP servers),
  // which made the first run take ~170s.
  options: { maxTurns: 1, allowedTools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("init: model=%s apiKeySource=%s", msg.model, msg.apiKeySource);
  } else if (msg.type === "assistant") {
    const text = msg.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    if (text) console.log("assistant:", text);
  } else if (msg.type === "result") {
    console.log("result: %s in %dms", msg.subtype, Date.now() - started);
  }
}
