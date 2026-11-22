// The team: workers (Claude, Codex, and OpenRouter when a key is set) that take tasks from the Lead.
//
//   assign -> worker edits its own copy -> the OTHER vendor cross-checks it -> Lead accepts or sends it back
//
// Accepting merges the worker's copy into the workspace (M4 adds conflict help and the final report).
import { resolve, sep, join, relative } from "node:path";
import { talkTools, talkDigest, TALK_TOOL_NAMES } from "./talk-tools.mjs";
import { libraryTools, LIBRARY_TOOL_NAMES } from "./library-tools.mjs";
import { claudeSession } from "./claude.mjs";
import { createWorktree, changes, mergeBranch, removeWorktree } from "./git.mjs";

export const NAMES = { claude: "Claude", codex: "Codex", openrouter: "OpenRouter" };
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = ["Read", "Glob", "Grep", "TodoWrite"];

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string" } },
  required: ["verdict", "notes"],
  additionalProperties: false,
};

export function startTeam({ workspace, worktreeRoot, emit, gate, board, codex, openrouter, tellLead, members, library, settings }) {
  const jobs = new Map(); // task num -> { worker, wt, session }
  const seen = new Map(); // participant -> newest team-talk message already shown to them
  const ALL = { claude: "Claude", codex: "Codex", ...(openrouter && { openrouter: `OpenRouter (${openrouter.model})` }) };
  // A workplace can choose who is on its team; unknown or unavailable names are ignored.
  const WORKERS = Object.fromEntries(Object.entries(ALL).filter(([k]) => !members?.length || members.includes(k)));
  if (!Object.keys(WORKERS).length) WORKERS.claude = ALL.claude; // a team always has at least one worker
  const workers = Object.keys(WORKERS);
  // Checkers, in order of preference: always a different vendor than the worker, Claude as the last resort.
  const unavailable = (w) => (w === "codex" ? codex.unavailableReason() : null);
  const checkersFor = (w) => [...workers.filter((x) => x !== w && x !== "claude" && !unavailable(x)), ...(w !== "claude" ? ["claude"] : [])];

  const status = (agent, state, task) => emit({ type: "status", agent, state, task });
  const activity = (agent, toolName, summary) => emit({ type: "tool", agent, toolName, summary });

  // ---- Automatic team notes --------------------------------------------------
  // When a worker changes a file, its teammates hear about it. When two workers change the same
  // file in their separate copies, everyone gets a warning early, instead of a clash at merge time.
  const noted = new Set(); // "worker|file" already announced
  const warned = new Set(); // "file|a|b" already warned
  const editors = new Map(); // file -> Set of workers who changed it in the current goal
  function onEdit(worker, dir, path) {
    if (!path) return;
    const file = relative(dir, resolve(dir, path)).split(sep).join("/");
    if (file.startsWith("..")) return;
    if (!noted.has(`${worker}|${file}`)) {
      noted.add(`${worker}|${file}`);
      board.say(worker, "", `changed ${file}`, "auto");
    }
    const who = editors.get(file) ?? new Set();
    who.add(worker);
    editors.set(file, who);
    const active = new Set([...jobs.values()].map((j) => j.worker));
    for (const o of [...who].filter((w) => w !== worker && active.has(w))) {
      const key = `${file}|${[o, worker].sort().join("|")}`;
      if (warned.has(key)) continue;
      warned.add(key);
      board.say("trident", "", `${NAMES[o]} and ${NAMES[worker]} both changed ${file} in their own copies. Agree on it before either is merged.`, "warning");
    }
  }

  // ---- Claude --------------------------------------------------------------
  function claudeWorker(dir, { readOnly, agent = "claude", provider }) {
    const inside = (p) => p && (resolve(dir, p) + sep).toLowerCase().startsWith((resolve(dir) + sep).toLowerCase());
    const teammates = ["lead", ...workers.filter((w) => w !== agent)].join(", ");
    return claudeSession({
      cwd: dir,
      instructions:
        `You are a ${readOnly ? "checker" : "worker"} on Trident, the user's multi-agent team. Your folder is ${dir}.\n` +
        `Your teammates in this workplace: ${teammates}. You can talk with them whenever it helps, with the team tools: say (send) and read (see new messages).\n` +
        `The shared Library (library tools: list, read, write) holds skills and notes; use it whenever it helps.\n\n${library?.guide() ?? ""}`,
      allowedTools: [...READ_TOOLS, ...TALK_TOOL_NAMES, ...(library ? LIBRARY_TOOL_NAMES : [])],
      mcpServers: { team: talkTools(board, agent, seen), ...(library && { library: libraryTools(library, agent) }) },
      ...(provider && { model: provider.model, env: provider.env }),
      onToolUse: (name, input) => {
        if (name.startsWith("mcp__team__") || name === "mcp__library__list" || name === "mcp__library__read") return;
        activity(agent, name, input.command ?? input.file_path ?? input.pattern ?? "");
        if (!readOnly && EDIT_TOOLS.has(name)) onEdit(agent, dir, input.file_path ?? input.notebook_path);
      },
      async canUseTool(toolName, input, { signal }) {
        // Workers may edit freely inside their own copy; checkers never edit.
        if (EDIT_TOOLS.has(toolName)) {
          if (readOnly) return { behavior: "deny", message: "You are checking, not editing. Report problems instead." };
          if (inside(input.file_path ?? input.notebook_path)) return { behavior: "allow", updatedInput: input };
        }
        return gate.request({ agent, toolName, input, signal });
      },
    });
  }

  // ---- Codex ---------------------------------------------------------------
  async function codexWorker(dir, { readOnly }) {
    const files = new Map(); // fileChange item id -> paths, for approval prompts
    const t = await codex.thread({
      cwd: dir,
      sandbox: readOnly ? "read-only" : "workspace-write",
      onItem(item) {
        if (item.type === "commandExecution") activity("codex", "Command", item.command);
        if (item.type === "fileChange") {
          files.set(item.id, item.changes.map((c) => c.path));
          activity("codex", "Edit", item.changes.map((c) => c.path).join(", "));
          if (!readOnly) for (const c of item.changes) onEdit("codex", dir, c.path);
        }
      },
      async onRequest(method, p) {
        if (method === "item/commandExecution/requestApproval") {
          const r = await gate.request({ agent: "codex", toolName: "Command", input: { command: p.command ?? "", cwd: p.cwd, reason: p.reason } });
          return { decision: r.behavior === "allow" ? "accept" : "decline" };
        }
        if (method === "item/fileChange/requestApproval") {
          if (readOnly) return { decision: "decline" };
          const r = await gate.request({ agent: "codex", toolName: "Edit", input: { file_path: (files.get(p.itemId) ?? []).join(", ") || p.grantRoot || dir, reason: p.reason } });
          return { decision: r.behavior === "allow" ? "accept" : "decline" };
        }
        if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
        return { decision: "decline" };
      },
    });
    return {
      run: (text) => t.run(text),
      check: (text) => t.run(text, { outputSchema: VERDICT_SCHEMA }),
      close: t.close,
    };
  }

  const open = (worker, dir, opts) =>
    worker === "codex" ? codexWorker(dir, opts) :
    worker === "openrouter" ? claudeWorker(dir, { ...opts, agent: "openrouter", provider: openrouter }) :
    claudeWorker(dir, opts);

  // ---- Prompts ---------------------------------------------------------------
  // Codex has no team tools yet, so it hears team talk at the start of each instruction instead.
  const withTalk = (worker, text) =>
    talkDigest(board, worker, seen) + text +
    (worker === "codex" ? "\n\n(You can't send team messages yet. Put anything your teammates should know in your summary.)" : "");

  function workPrompt({ goal, task }, dir) {
    return [
      `Your task (#${task.num}): ${task.title}`,
      task.detail && `Details: ${task.detail}`,
      `It is part of the goal "${goal.title}", which is done when: ${goal.done_when}`,
      `Work only inside ${dir}. It is your own copy of the project; other workers have their own.`,
      `Make the change, check that it works, then finish with a plain 2-4 sentence summary of what you changed and how you checked it. Do not commit; Trident does that.`,
    ].filter(Boolean).join("\n");
  }

  function checkPrompt({ goal, task }, dir, summary, diff) {
    const shown = diff.length > 60000 ? diff.slice(0, 60000) + "\n[diff cut short]" : diff;
    return [
      `You are cross-checking another agent's work. Do not change any files.`,
      `Task (#${task.num}): ${task.title}`,
      task.detail && `Details: ${task.detail}`,
      `Goal: ${goal.title}. Done when: ${goal.done_when}`,
      `The worker says: ${summary || "(no summary)"}`,
      `The changes (git diff):\n\`\`\`diff\n${shown || "(no file changes)"}\n\`\`\``,
      `The changed project is in ${dir}. Read files there, and run checks if useful. Judge only this task: is it done correctly and completely, with nothing broken? Small style preferences are not failures.`,
      `Answer with JSON only: {"verdict": "pass" or "fail", "notes": "one to three plain sentences"}.`,
    ].filter(Boolean).join("\n\n");
  }

  function parseVerdict(text) {
    const m = String(text).match(/\{[\s\S]*\}/);
    try {
      const v = JSON.parse(m?.[0] ?? text);
      if (v.verdict === "pass" || v.verdict === "fail") return { verdict: v.verdict, notes: String(v.notes ?? "") };
    } catch {}
    return { verdict: "fail", notes: `The checker's answer could not be read: ${String(text).slice(0, 200)}` };
  }

  const oneLine = (s, n = 160) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  async function crossCheck(checker, ctx, dir, summary, diff) {
    status(checker, "checking", ctx.task.num);
    const reviewer = await open(checker, dir, { readOnly: true });
    try {
      const prompt = checkPrompt(ctx, dir, summary, diff);
      return parseVerdict(checker === "codex" ? await reviewer.check(prompt) : await reviewer.run(prompt));
    } finally {
      reviewer.close();
      status(checker, "idle");
    }
  }

  // ---- One round: work, then cross-check, then report to the Lead ------------
  async function round(num, message) {
    const job = jobs.get(num);
    const { worker, wt } = job;
    try {
      status(worker, "working", num);
      const summary = await job.session.run(withTalk(worker, message));
      if (jobs.get(num) !== job) return; // cancelled while it was working
      status(worker, "idle");
      const { stat, diff } = changes(wt.dir, wt.base);

      const ctx = board.task(num);
      board.updateTask(num, { status: "review", note: oneLine(summary), check_verdict: "", check_note: "" });
      // Try each other vendor in turn; one that is unavailable (for example, out of usage) is skipped and named.
      let checker, v;
      const skipped = [];
      for (const c of checkersFor(worker)) {
        checker = c;
        board.updateTask(num, { check_by: c });
        try {
          v = await crossCheck(c, ctx, wt.dir, summary, diff);
          break;
        } catch (err) {
          skipped.push(`${NAMES[c]} could not check it: ${oneLine(err.message, 100)}`);
        }
      }
      if (!v) v = { verdict: "fail", notes: "No other worker was able to check this." };
      if (skipped.length) v.notes = `(${skipped.join("; ")}) ${v.notes}`;
      board.updateTask(num, { check_verdict: v.verdict, check_note: oneLine(v.notes, 300) });

      emit({ type: "message", agent: "team", text: `${WORKERS[worker]} finished task ${num}. ${WORKERS[checker]} checked it: ${v.verdict === "pass" ? "looks right" : "found a problem"}. ${v.notes}` });
      tellLead(
        `[team] Task ${num} "${ctx.task.title}" has a candidate from ${WORKERS[worker]}.\n` +
          `${WORKERS[worker]}'s summary: ${summary}\n` +
          `Files changed:\n${stat || "(none)"}\n` +
          `Cross-check by ${WORKERS[checker]}: ${v.verdict.toUpperCase()} — ${v.notes}\n` +
          `Decide now: accept_task to merge it, or reject_task with exactly what to fix.`,
      );
    } catch (err) {
      status(worker, "idle");
      board.updateTask(num, { status: "blocked", note: oneLine(`Stopped: ${err.message}`) });
      tellLead(`[team] Task ${num} stopped with an error: ${err.message}. You can assign it again.`);
    }
  }

  // ---- How many work at once --------------------------------------------------
  // The user picks the number in Settings. Extra rounds wait in line and start by themselves.
  let running = 0;
  const queue = []; // [num, message]
  const limit = () => settings?.get().maxAgents ?? 3;
  function startRound(num, message) {
    if (running >= limit()) {
      queue.push([num, message]);
      board.updateTask(num, { note: `Waiting for a free spot (${limit()} at once).` });
      return false;
    }
    running++;
    round(num, message).finally(() => {
      running--;
      while (queue.length && running < limit()) {
        const [n, m] = queue.shift();
        if (jobs.has(n)) startRound(n, m);
      }
    });
    return true;
  }

  // ---- What the Lead can do --------------------------------------------------
  return {
    workers,
    names: WORKERS,
    async assign(num, worker, instructions) {
      if (!WORKERS[worker]) return `Unknown worker "${worker}". Use one of: ${workers.join(", ")}.`;
      if (unavailable(worker)) return `${unavailable(worker)} Give this task to another worker, or ask the user whether to wait.`;
      const ctx = board.task(num);
      if (!ctx || ctx.goal.status !== "active") return "There is no approved plan with that task.";
      if (ctx.task.status === "done") return `Task ${num} is already done.`;
      if (jobs.has(num) && ctx.task.status !== "blocked") return `Task ${num} is already with ${WORKERS[jobs.get(num).worker]}.`;
      const waiting = ctx.task.depends_on.filter((d) => ctx.tasks.find((t) => t.num === d)?.status !== "done");
      if (waiting.length) return `Task ${num} has to wait for task ${waiting.join(", ")} to be done first.`;

      jobs.get(num)?.session.close();
      const wt = createWorktree(workspace, worktreeRoot, `g${ctx.goal.id}-t${num}`);
      board.updateTask(num, { status: "working", owner: worker, branch: wt.branch, worktree: wt.dir, base: wt.base, note: "", check_by: "", check_verdict: "", check_note: "" });
      const session = await open(worker, wt.dir, { readOnly: false });
      jobs.set(num, { worker, wt, session });
      const prompt = workPrompt(board.task(num), wt.dir) + (instructions ? `\n\nFrom the Lead: ${instructions}` : "");
      // Runs in the background; the Lead hears back with a [team] message.
      if (!startRound(num, prompt)) return `Task ${num} is with ${worker}, waiting in line: ${limit()} workers are already busy. It starts by itself when one finishes. End your turn now.`;
      return null;
    },

    reject(num, feedback) {
      const job = jobs.get(num);
      const ctx = board.task(num);
      if (!job || ctx?.task.status !== "review") return `Task ${num} is not waiting for review.`;
      board.updateTask(num, { status: "working", check_verdict: "", check_note: "" });
      emit({ type: "message", agent: "team", text: `Sent task ${num} back to ${WORKERS[job.worker]}: ${feedback}` });
      startRound(num, `Your work on task ${num} was not accepted yet. Fix this, then finish with a new summary:\n${feedback}`);
      return null;
    },

    accept(num, note) {
      const ctx = board.task(num);
      if (ctx?.task.status !== "review" || !ctx.task.branch) return `Task ${num} is not waiting for review.`;
      const err = mergeBranch(workspace, ctx.task.branch, `Task ${num}: ${ctx.task.title}`);
      if (err) {
        board.updateTask(num, { status: "blocked", note: oneLine(err) });
        return err;
      }
      jobs.get(num)?.session.close();
      jobs.delete(num);
      removeWorktree(workspace, ctx.task.worktree);
      board.updateTask(num, { status: "done", note: oneLine(note || ctx.task.note) });
      emit({ type: "message", agent: "team", text: `Task ${num} accepted and added to your workspace.` });
      return null;
    },

    // Stop every worker in this workplace (the goal was cancelled or the workplace removed).
    // Their copies stay on disk; nothing is merged.
    stopAll() {
      for (const [num, j] of jobs) {
        j.session.close();
        status(j.worker, "idle");
        jobs.delete(num);
      }
      queue.length = 0;
      noted.clear();
      warned.clear();
      editors.clear();
    },
  };
}

export const worktreeRootFor = (dataDir) => join(dataDir, "worktrees");
