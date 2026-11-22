// Team talk tools for workers that run in the Claude harness (Claude and OpenRouter workers).
// Talking never wakes anyone: a message waits until its reader next looks, so no one gets stuck waiting
// and two agents cannot pull each other into an endless back-and-forth.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const text = (t) => ({ content: [{ type: "text", text: t }] });
export const TALK_TOOL_NAMES = ["say", "read"].map((n) => `mcp__team__${n}`);

// `who` is this participant's name ("claude", "codex", "openrouter" or "lead").
// `seen` remembers the newest message this participant has already been shown.
export function talkTools(board, who, seen) {
  return createSdkMcpServer({
    name: "team",
    version: "1.0.0",
    tools: [
      tool(
        "say",
        "Send a message to your teammates in this workplace: a question, an update, a heads-up about a file you're changing, an idea. " +
          "Leave 'to' empty to tell everyone. Nobody is interrupted; they see it the next time they read.",
        {
          text: z.string().describe("What you want to say, in plain words."),
          to: z.enum(["lead", "claude", "codex", "openrouter"]).optional().describe("One teammate, or leave empty for everyone."),
        },
        async ({ text: t, to }) => {
          if (to === who) return text("That's you. Pick a teammate, or leave 'to' empty for everyone.");
          return text(board.say(who, to, t) ? "Sent." : "Nothing to send.");
        },
      ),
      tool(
        "read",
        "Read new messages from your teammates in this workplace (anything you haven't seen yet).",
        {},
        async () => {
          const msgs = board.talkFor(who, 20, seen.get(who) ?? 0);
          if (!msgs.length) return text("No new messages.");
          seen.set(who, msgs.at(-1).id);
          return text(msgs.map(board.talkLine).join("\n"));
        },
      ),
    ],
  });
}

// New messages for a participant as a short block to put in front of their next instruction.
export function talkDigest(board, who, seen) {
  const msgs = board.talkFor(who, 12, seen.get(who) ?? 0);
  if (!msgs.length) return "";
  seen.set(who, msgs.at(-1).id);
  return `[team talk since you last looked]\n${msgs.map(board.talkLine).join("\n")}\n\n`;
}
