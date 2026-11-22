// Spike: confirm the Codex SDK runs with the existing Codex (ChatGPT) login.
import { Codex } from "@openai/codex-sdk";

const started = Date.now();
const codex = new Codex();
const thread = codex.startThread({ skipGitRepoCheck: true, sandboxMode: "read-only" });
const { events } = await thread.runStreamed("Reply with exactly the word: pong. Do not run any commands.");
for await (const ev of events) {
  if (ev.type === "thread.started") console.log("thread:", ev.thread_id);
  else if (ev.type === "item.completed" && ev.item.type === "agent_message") console.log("assistant:", ev.item.text);
  else if (ev.type === "turn.completed") console.log("done in %dms, usage=%j", Date.now() - started, ev.usage);
  else if (ev.type === "turn.failed" || ev.type === "error") console.log("FAILED:", JSON.stringify(ev));
}
