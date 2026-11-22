// The lead agent: one long-lived Claude session fed by a message queue.
// Every risky tool call goes through the approval gate before it runs.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { boardTools, BOARD_TOOL_NAMES } from "./board-tools.mjs";

const LEAD_PROMPT = (cwd, team) => `You are the Lead in Trident, the user's personal multi-agent workspace. You own the user's goal.
The user is not a programmer: be concise and plain-spoken, no jargon.

How you work:
- Questions, and changes to a single file: just answer or do them yourself.
- Anything that creates or changes more than one file, or needs more than one step: FIRST call propose_plan (goal, one checkable "Done when" statement, and short tasks, each with an owner), then END YOUR TURN and wait. Do not start the work until the user approves. If they ask for changes, call propose_plan again with the revised plan.

Your team:
- Workers: ${team.workers.map((w) => `'${w}' (${team.names[w]})`).join(", ")}. Give tasks that change files to them with assign_task; mix them when there are several tasks. Keep 'lead' tasks for quick checks you do yourself (track those with update_task).
- Each worker edits its own copy of the project. When one finishes, a worker from a DIFFERENT vendor cross-checks it, and you receive a [team] message with the summary, the files changed and the verdict.
- On a [team] message, decide right away: accept_task (merges it into the workspace) when the cross-check passes and the result fits the goal; otherwise reject_task with specific feedback. A failed cross-check usually means reject, unless you can see the checker is wrong; say why.
- Assign independent tasks together. A task whose depends_on tasks are not done yet cannot be assigned. After assigning, end your turn; never wait, sleep or poll.
- When every task is done, check the "Done when" statement for real in your working folder (run it, open it, test it), then call finish_goal with how you checked, and tell the user the result in two or three sentences.
Team talk: your workers can message each other and you while they work. Recent talk appears in your [state] block, and you can reply with team_say.

Comparing models:
- When the user wants several models' views on a question (compare, "ask GPT and Gemini", a second opinion, side by side), call ask_several. The answers appear side by side on the user's screen; then reply with a short summary: where they agree, where they differ, and which answer you would trust and why. Do not repeat the answers in full.
- ask_several answers questions only; it does not change files. Use OpenRouter names like "openai/gpt-6.2-sol" exactly as the user gives them, plus "claude" (local) and "codex" (local).
- Every message starts with a [state] block showing the board. Trust it; it is current.
Your working folder is ${cwd}.`;

// Tools that only read are allowed without asking.
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

export function startLead({ cwd, emit, gate, board, team, askSeveral }) {
  const inbox = [];
  let wake = null;
  let closed = false;

  async function* messages() {
    while (!closed) {
      while (inbox.length) {
        yield { type: "user", message: { role: "user", content: inbox.shift() }, parent_tool_use_id: null };
      }
      await new Promise((r) => (wake = r));
    }
  }

  const q = query({
    prompt: messages(),
    options: {
      cwd,
      // Keep Trident isolated from the user's global Claude Code plugins and hooks (they cost ~100s per start).
      settingSources: [],
      mcpServers: { board: boardTools(board, team, askSeveral) },
      strictMcpConfig: true,
      // Board tools only change Trident's own board, so they never need approval.
      allowedTools: [...READ_ONLY_TOOLS, ...BOARD_TOOL_NAMES],
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: LEAD_PROMPT(cwd, team) },
      canUseTool: async (toolName, input, { signal }) => gate.request({ agent: "lead", toolName, input, signal }),
    },
  });

  let busy = false;
  (async () => {
    try {
      for await (const m of q) handle(m);
    } catch (err) {
      emit({ type: "error", agent: "lead", text: String(err?.message ?? err) });
    }
    emit({ type: "status", agent: "lead", state: "stopped" });
  })();

  function handle(m) {
    if (m.type === "system" && m.subtype === "init") {
      // init arrives while the first message is being handled, so keep the working state.
      emit({ type: "status", agent: "lead", state: busy ? "working" : "idle", model: m.model });
    } else if (m.type === "stream_event") {
      const ev = m.event;
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        emit({ type: "delta", agent: "lead", text: ev.delta.text });
      }
    } else if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) emit({ type: "message", agent: "lead", text: block.text });
        // Board tool calls show up on the board itself, not in Activity.
        if (block.type === "tool_use" && !block.name.startsWith("mcp__board__") && block.name !== "ToolSearch") emit({ type: "tool", agent: "lead", toolName: block.name, summary: summarize(block.name, block.input) });
      }
    } else if (m.type === "result") {
      busy = false;
      emit({ type: "status", agent: "lead", state: "idle", ok: m.subtype === "success", ms: m.duration_ms });
    }
  }

  return {
    send(text) {
      inbox.push(`${board.stateBlock()}\n\n${text}`);
      busy = true;
      emit({ type: "status", agent: "lead", state: "working" });
      wake?.();
    },
    interrupt: () => q.interrupt(),
    // Ending the input stream lets the Lead's Claude process exit (used when a workplace is removed).
    close() {
      closed = true;
      wake?.();
    },
    get busy() {
      return busy;
    },
  };
}

// One short line describing a tool call, for the activity view.
export function summarize(toolName, input = {}) {
  if (input.command) return String(input.command).slice(0, 200);
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  return JSON.stringify(input).slice(0, 200);
}
