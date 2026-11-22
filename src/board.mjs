// The board: goals and their tasks, stored in SQLite (built into Node).
// One goal is "current" at a time; older goals stay for history.
//
// Goal status: proposed -> active -> done   (or: proposed -> replaced, active -> cancelled)
// Task status: todo | working | review | blocked | done
import { DatabaseSync } from "node:sqlite";

export const TASK_STATUSES = ["todo", "working", "review", "blocked", "done"];

export function openBoard(file, emit) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, done_when TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL REFERENCES goals(id), num INTEGER NOT NULL,
      title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT 'lead',
      depends_on TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'todo',
      note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
  `);
  // M3 columns: where a worker's copy lives, and what the cross-check said.
  const have = new Set(db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name));
  for (const col of ["branch", "worktree", "base", "check_by", "check_verdict", "check_note"]) {
    if (!have.has(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  // Team talk: messages between the Lead and workers in this workplace. `to_who` empty means everyone.
  // Kind "note" is written by a worker or the Lead; "auto" and "warning" are written by Trident itself.
  db.exec(`CREATE TABLE IF NOT EXISTS talk (
    id INTEGER PRIMARY KEY, from_who TEXT NOT NULL, to_who TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'note', text TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  // Worker sessions do not survive a restart, so unfinished work is marked as stopped.
  db.prepare(`UPDATE tasks SET status = 'blocked', note = 'Stopped when Trident restarted. Assign it again.' WHERE status = 'working' AND owner != 'lead'`).run();

  const now = () => Date.now();
  const current = () =>
    db.prepare(`SELECT * FROM goals WHERE status IN ('proposed','active') ORDER BY id DESC LIMIT 1`).get() ?? null;
  const tasksOf = (goalId) =>
    db.prepare(`SELECT * FROM tasks WHERE goal_id = ? ORDER BY num`).all(goalId).map((t) => ({ ...t, depends_on: JSON.parse(t.depends_on) }));

  // What the user sees: the newest goal, including one just finished.
  function snapshot() {
    const goal = db.prepare(`SELECT * FROM goals WHERE status IN ('proposed','active','done','cancelled') ORDER BY id DESC LIMIT 1`).get() ?? null;
    return { goal, tasks: goal ? tasksOf(goal.id) : [] };
  }
  const changed = () => emit({ type: "board", ...snapshot() });

  // A new plan replaces any plan still waiting for approval, and cancels an active goal.
  function proposePlan({ goal, done_when, tasks }) {
    const prev = current();
    if (prev) db.prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(prev.status === "proposed" ? "replaced" : "cancelled", now(), prev.id);
    const { lastInsertRowid: goalId } = db
      .prepare(`INSERT INTO goals (title, done_when, status, created_at, updated_at) VALUES (?, ?, 'proposed', ?, ?)`)
      .run(goal, done_when, now(), now());
    const ins = db.prepare(`INSERT INTO tasks (goal_id, num, title, detail, owner, depends_on, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    tasks.forEach((t, i) => ins.run(goalId, i + 1, t.title, t.detail ?? "", t.owner ?? "lead", JSON.stringify(t.depends_on ?? []), now()));
    changed();
    return Number(goalId);
  }

  function setGoalStatus(status) {
    const g = current();
    if (!g) return false;
    db.prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), g.id);
    changed();
    return true;
  }

  const FIELDS = ["status", "note", "owner", "branch", "worktree", "base", "check_by", "check_verdict", "check_note"];
  function updateTask(num, fields) {
    const g = current();
    if (!g || g.status !== "active") return "There is no approved plan to update.";
    if (fields.status && !TASK_STATUSES.includes(fields.status)) return `Unknown status ${fields.status}.`;
    const t = db.prepare(`SELECT * FROM tasks WHERE goal_id = ? AND num = ?`).get(g.id, num);
    if (!t) return `There is no task ${num}.`;
    const set = FIELDS.filter((f) => fields[f] !== undefined);
    if (set.length) db.prepare(`UPDATE tasks SET ${set.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...set.map((f) => String(fields[f])), now(), t.id);
    changed();
    return null;
  }

  // One task of the current goal, plus the goal itself.
  function task(num) {
    const g = current();
    if (!g) return null;
    const t = tasksOf(g.id).find((x) => x.num === num);
    return t ? { goal: g, task: t, tasks: tasksOf(g.id) } : null;
  }

  // The short [state] block the Lead sees at the top of every message (PandaOS's idea).
  function stateBlock() {
    const { goal, tasks } = snapshot();
    if (!goal) return "[state] No goal yet.";
    if (goal.status === "done") return `[state] Last goal finished: ${goal.title}. No goal is open.`;
    if (goal.status === "cancelled") return `[state] The user cancelled the last goal (${goal.title}). No goal is open.`;
    const lines = [`[state] Goal (${goal.status === "proposed" ? "plan waiting for the user's approval" : goal.status}): ${goal.title}`, `Done when: ${goal.done_when}`];
    for (const t of tasks) {
      const who = t.owner && t.owner !== "lead" ? ` (${t.owner})` : "";
      const check = t.check_verdict ? ` [checked by ${t.check_by}: ${t.check_verdict}]` : "";
      lines.push(`  ${t.num}. [${t.status}]${who} ${t.title}${t.note ? ` — ${t.note}` : ""}${check}`);
    }
    const recent = talkFor("lead", 6);
    if (recent.length) lines.push("Recent team talk:", ...recent.map((m) => `  ${talkLine(m)}`));
    return lines.join("\n");
  }

  // ---- Team talk ----
  function say(from, to, text, kind = "note") {
    const t = String(text ?? "").trim().slice(0, 2000);
    if (!t) return null;
    const { lastInsertRowid } = db.prepare(`INSERT INTO talk (from_who, to_who, kind, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(from, to ?? "", kind, t, now());
    const msg = { id: Number(lastInsertRowid), from_who: from, to_who: to ?? "", kind, text: t, created_at: now() };
    emit({ type: "talk", ...msg });
    return msg;
  }
  // Messages a participant can see (to everyone, or to them; not their own), newest last.
  const talkFor = (who, limit = 10, afterId = 0) =>
    db.prepare(`SELECT * FROM talk WHERE id > ? AND from_who != ? AND (to_who = '' OR to_who = ?) ORDER BY id DESC LIMIT ?`)
      .all(afterId, who, who, limit).reverse();
  const talkLine = (m) => `${m.kind === "warning" ? "WARNING " : ""}${m.from_who}${m.to_who ? ` → ${m.to_who}` : ""}: ${m.text}`;
  const recentTalk = (limit = 50) => db.prepare(`SELECT * FROM talk ORDER BY id DESC LIMIT ?`).all(limit).reverse();

  return { snapshot, proposePlan, setGoalStatus, updateTask, task, stateBlock, changed, say, talkFor, talkLine, recentTalk };
}
