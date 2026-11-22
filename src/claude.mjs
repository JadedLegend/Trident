// A Claude worker session: one long-lived Claude conversation, fed one message at a time.
// `run(text)` resolves with Claude's final reply for that message.
import { query } from "@anthropic-ai/claude-agent-sdk";

export function claudeSession({ cwd, instructions, allowedTools, canUseTool, onToolUse, model, env, mcpServers = {} }) {
  const inbox = [];
  let wake = null;
  let waiting = null; // the run() currently waiting for a reply
  let closed = false;

  async function* messages() {
    while (!closed) {
      while (inbox.length) yield { type: "user", message: { role: "user", content: inbox.shift() }, parent_tool_use_id: null };
      await new Promise((r) => (wake = r));
    }
  }

  const q = query({
    prompt: messages(),
    options: {
      cwd,
      settingSources: [], // isolated from the user's global plugins and hooks
      mcpServers,
      strictMcpConfig: true,
      allowedTools,
      systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
      canUseTool,
      ...(model && { model }),
      ...(env && { env }),
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === "assistant") {
          for (const b of m.message.content) if (b.type === "tool_use") onToolUse?.(b.name, b.input);
        } else if (m.type === "result") {
          const w = waiting;
          waiting = null;
          // An API failure (bad key, no credit) can arrive as a "success" result with is_error set.
          if (m.subtype === "success" && !m.is_error) w?.resolve(m.result ?? "");
          else w?.reject(new Error(m.is_error ? String(m.result ?? "API error").slice(0, 300) : `Claude stopped: ${m.subtype}`));
        }
      }
    } catch (err) {
      waiting?.reject(err);
    }
  })();

  return {
    run(text) {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        inbox.push(text);
        wake?.();
      });
    },
    // Ending the input stream lets the Claude process exit.
    close() {
      closed = true;
      wake?.();
    },
  };
}
