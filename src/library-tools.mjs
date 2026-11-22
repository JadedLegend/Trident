// Library tools for agents that run in the Claude harness (the Lead, Claude and OpenRouter workers).
// Agents can read anything and change anything; a change becomes a draft the user saves (or not).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const text = (t) => ({ content: [{ type: "text", text: t }] });
export const LIBRARY_TOOL_NAMES = ["list", "read", "write"].map((n) => `mcp__library__${n}`);

export function libraryTools(library, who) {
  return createSdkMcpServer({
    name: "library",
    version: "1.0.0",
    tools: [
      tool("list", "List every note in the shared Library (skills, ideas, research), by section.", {}, async () => text(library.list() || "The Library is empty.")),
      tool(
        "read",
        "Read one Library note, for example music/mixing.md or guide.md.",
        { path: z.string().describe("The note's path, like ideas/album-names.md") },
        async ({ path }) => {
          const r = library.read(path);
          if (r.error) return text(r.error);
          return text([
            r.text !== null ? r.text : "(This note only exists as an unsaved draft so far.)",
            r.draft !== null && `\n--- unsaved draft by ${r.draftInfo?.by ?? "someone"} ---\n${r.draft}`,
          ].filter(Boolean).join("\n"));
        },
      ),
      tool(
        "write",
        "Create or change a Library note, so it fits the user and the work better. Write the whole note. " +
          "It is kept as a draft until the user saves it, and the old version is always kept.",
        {
          path: z.string().describe("Section and name, like music/mixing.md. New sections are fine."),
          text: z.string().describe("The complete note, in Markdown."),
          why: z.string().describe("One short sentence for the user: what changed and why."),
        },
        async ({ path, text: t, why }) => {
          const r = library.draft(path, t, who, why);
          return text(r.error ?? `Saved as a draft (${r.path}). The user will see it and decide.`);
        },
      ),
    ],
  });
}
