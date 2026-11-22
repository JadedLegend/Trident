// Spike: is the slowness a one-time startup cost, or per message?
// Claude: one long-lived session fed two messages (streaming input mode).
// Codex: two runs on the same thread.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";

const which = process.argv[2];
const t0 = Date.now();
const stamp = (label) => console.log(`${label} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (which === "claude") {
  let release;
  const gate = () => new Promise((r) => (release = r));
  async function* messages() {
    yield { type: "user", message: { role: "user", content: "Reply with exactly: one" }, parent_tool_use_id: null };
    await gate(); // wait until the first result arrives
    yield { type: "user", message: { role: "user", content: "Reply with exactly: two" }, parent_tool_use_id: null };
  }
  const q = query({
    prompt: messages(),
    options: { allowedTools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true },
  });
  let results = 0;
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") stamp("init");
    if (m.type === "result") {
      stamp(`result ${++results}: ${m.result}`);
      if (results === 1) release();
      else break;
    }
  }
} else {
  const thread = new Codex().startThread({ skipGitRepoCheck: true, sandboxMode: "read-only" });
  const a = await thread.run("Reply with exactly: one. Run no commands.");
  stamp(`turn 1: ${a.finalResponse}`);
  const b = await thread.run("Reply with exactly: two. Run no commands.");
  stamp(`turn 2: ${b.finalResponse}`);
}
