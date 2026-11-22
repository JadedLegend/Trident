// Board tools the Lead calls. They run inside Trident (an in-process MCP server),
// so the Lead changes the board only through these, never by editing files.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TASK_STATUSES } from "./board.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });

export const BOARD_TOOL_NAMES = ["propose_plan", "update_task", "finish_goal", "assign_task", "accept_task", "reject_task", "ask_several", "team_say"].map((n) => `mcp__board__${n}`);

export function boardTools(board, team, askSeveral) {
  return createSdkMcpServer({
    name: "board",
    version: "1.0.0",
    tools: [
      tool(
        "propose_plan",
        "Propose a goal and its task plan to the user for approval. Use this before any substantial work. " +
          "After calling it, STOP: end your turn and wait. The user's approval or change request arrives as their next message.",
        {
          goal: z.string().describe("The outcome, in a few plain words, e.g. 'Add a login page'."),
          done_when: z.string().describe("ONE checkable statement that is true when the goal is finished, e.g. 'A user can sign in and the tests pass'."),
          tasks: z
            .array(
              z.object({
                title: z.string().describe("Short task name, a few words."),
                detail: z.string().optional().describe("What to do and what it produces, one or two sentences."),
                owner: z.enum(["lead", ...team.workers]).optional().describe("Who should do it: a worker, or 'lead' for quick work you do yourself."),
                depends_on: z.array(z.number().int()).optional().describe("Numbers (1-based) of tasks that must finish first."),
              }),
            )
            .min(1)
            .max(12),
        },
        async (args) => {
          board.proposePlan(args);
          return text("The plan is on the user's screen waiting for approval. End your turn now and wait for their answer.");
        },
      ),
      tool(
        "update_task",
        "Set a task's status as you work: 'working' when you start it, 'done' when finished, 'blocked' with a note saying why.",
        {
          task: z.number().int().describe("The task number from the plan."),
          status: z.enum(TASK_STATUSES),
          note: z.string().optional().describe("One short line the user will see, e.g. what was produced or why it is blocked."),
        },
        async ({ task, status, note }) => {
          const t = board.task(task)?.task;
          if (t && t.owner !== "lead" && t.branch) return text(`Task ${task} belongs to a worker. Use accept_task or reject_task instead.`);
          const err = board.updateTask(task, { status, note, owner: "lead" });
          return text(err ?? `Task ${task} is now ${status}.`);
        },
      ),
      tool(
        "finish_goal",
        "Mark the current goal done. Only call this after every task is done AND you have checked the 'Done when' statement is true.",
        { evidence: z.string().describe("How you checked the 'Done when' statement, in one or two sentences.") },
        async ({ evidence }) => {
          const { goal, tasks } = board.snapshot();
          if (!goal || goal.status !== "active") return text("There is no approved goal to finish.");
          const open = tasks.filter((t) => t.status !== "done");
          if (open.length) return text(`Not finished: task(s) ${open.map((t) => t.num).join(", ")} are not done.`);
          board.setGoalStatus("done");
          return text(`Goal marked done. Tell the user what was achieved. Evidence recorded: ${evidence}`);
        },
      ),
      tool(
        "team_say",
        "Send a message to your workers in team talk: guidance, an answer to their question, a heads-up. Leave 'to' empty for everyone. They see it the next time they read.",
        {
          text: z.string(),
          to: z.enum(["claude", "codex", "openrouter"]).optional(),
        },
        async ({ text: t, to }) => text(board.say("lead", to, t) ? "Sent." : "Nothing to send."),
      ),
      tool(
        "ask_several",
        "Ask several models the same question at once; their answers appear side by side for the user. Answers only, no file changes. " +
          "Afterwards, summarize agreements, differences and which answer you trust.",
        {
          question: z.string().describe("The question, written so each model can answer it on its own."),
          models: z.array(z.string()).min(2).max(4).optional()
            .describe("2-4 sources: 'claude', 'codex', or OpenRouter ids like 'openai/gpt-6.2-sol'. Omit for the default set."),
        },
        async ({ question, models }) => {
          const r = await askSeveral(question, models);
          if (r.error) return text(r.error);
          const parts = r.answers.map((a) => `### ${a.label}${a.state === "failed" ? " (failed)" : ""}\n${a.text}`);
          return text(`${parts.join("\n\n")}\n\n(OpenRouter cost for this comparison: $${r.cost.toFixed(4)})`);
        },
      ),
      tool(
        "assign_task",
        "Give a task to a worker. The worker edits its own copy of the project; when it finishes, the other worker cross-checks it " +
          "and you get a [team] message with both results. Independent tasks can be assigned at the same time. After assigning, end your turn; do not wait or poll.",
        {
          task: z.number().int().describe("The task number from the plan."),
          worker: z.enum(team.workers),
          instructions: z.string().optional().describe("Anything extra the worker should know, beyond the task's title and detail."),
        },
        async ({ task, worker, instructions }) => {
          const err = await team.assign(task, worker, instructions);
          return text(err ?? `Task ${task} is with ${worker}. End your turn now; a [team] message will arrive when it is ready for review.`);
        },
      ),
      tool(
        "accept_task",
        "Accept a worker's result after reading the cross-check. This merges it into the workspace and marks the task done.",
        { task: z.number().int(), note: z.string().optional().describe("One short line for the board: what the task produced.") },
        async ({ task, note }) => text(team.accept(task, note) ?? `Task ${task} is merged and done.`),
      ),
      tool(
        "reject_task",
        "Send a worker's result back with what to fix. The same worker fixes it and it is cross-checked again.",
        { task: z.number().int(), feedback: z.string().describe("Exactly what is wrong and what to change.") },
        async ({ task, feedback }) => text(team.reject(task, feedback) ?? `Task ${task} went back to its worker. End your turn and wait for the [team] message.`),
      ),
    ],
  });
}
