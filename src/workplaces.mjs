// Workplaces: separate studios, each with its own folder, board, Lead, chat and team.
// They share the approval gate, the Codex process and the OpenRouter key, but nothing else.
//
// The list lives in data/workplaces.json. The first workplace ("Main") keeps the original
// data/ files and workspace folder, so nothing from before workplaces existed is lost.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, parse, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { startLead } from "./lead.mjs";
import { openBoard } from "./board.mjs";
import { startTeam, worktreeRootFor } from "./team.mjs";
import { ensureRepo } from "./git.mjs";
import { startCompare } from "./compare.mjs";

const KNOWN_WORKERS = ["claude", "codex", "openrouter"];

export function openWorkplaces({ root, dataDir, emit, gate, codex, openrouter }) {
  const listFile = join(dataDir, "workplaces.json");
  let list = [];
  try { list = JSON.parse(readFileSync(listFile, "utf8")); } catch {}
  if (!list.length) {
    list = [{ id: "main", name: "Main", folder: process.env.TRIDENT_WORKSPACE ?? join(root, "workspace"), members: [], created_at: Date.now() }];
  }
  const save = () => writeFileSync(listFile, JSON.stringify(list, null, 2));
  save();

  const live = new Map(); // id -> running workplace

  function start(w) {
    const wdata = w.id === "main" ? dataDir : join(dataDir, "workplaces", w.id);
    mkdirSync(wdata, { recursive: true });
    mkdirSync(w.folder, { recursive: true });
    ensureRepo(w.folder);

    const emitWp = (e) => emit({ ...e, wp: w.id });
    const gateWp = { request: (o) => gate.request({ ...o, wp: w.id }) };
    const board = openBoard(join(wdata, "trident.db"), emitWp);
    const askSeveral = startCompare({ emit: emitWp, codex, openRouterKey: openrouter?.key, cwd: w.folder });
    let lead = null;
    const team = startTeam({
      workspace: w.folder,
      worktreeRoot: worktreeRootFor(wdata),
      emit: emitWp,
      gate: gateWp,
      board,
      codex,
      openrouter,
      members: w.members,
      tellLead: (text) => lead.send(text),
    });
    lead = startLead({ cwd: w.folder, emit: emitWp, gate: gateWp, board, team, askSeveral });

    board.changed();
    for (const m of board.recentTalk(50)) emitWp({ type: "talk", ...m }); // put earlier team talk on screen
    emitWp({ type: "status", agent: "lead", state: "idle" });
    for (const agent of team.workers) emitWp({ type: "status", agent, state: "idle" });
    const running = { ...w, board, lead, team };
    live.set(w.id, running);
    return running;
  }

  // What the screen needs to draw the sidebar.
  const summary = (w) => ({ id: w.id, name: w.name, folder: w.folder, members: live.get(w.id)?.team.workers ?? w.members });
  const announce = () => emit({ type: "workplaces", list: list.map(summary) });

  // Check a folder a person typed, and explain any problem in plain words.
  function checkFolder(folder) {
    if (!isAbsolute(folder)) return "Use a full folder path, starting with a drive letter, like C:\\Users\\you\\Projects\\Name.";
    const f = resolve(folder);
    if (parse(f).root === f) return "That's a whole drive. Pick a folder inside it.";
    const lower = (p) => resolve(p).toLowerCase() + sep;
    const inside = (a, b) => lower(a).startsWith(lower(b));
    if (inside(f, root) && !inside(f, join(root, "workplaces")) && !inside(f, join(root, "workspace"))) return "That folder is part of Trident itself. Pick a different one.";
    const clash = list.find((w) => inside(f, w.folder) || inside(w.folder, f));
    if (clash) return `The workplace "${clash.name}" already uses that folder (or one inside it). Each workplace needs its own folder.`;
    if (existsSync(f) && !statSync(f).isDirectory()) return "That path is a file, not a folder.";
    if (existsSync(join(f, ".git"))) return "That folder already has its own version history (git). Trident would add its own saves to it, so for now pick a new or plain folder.";
    return null;
  }

  function create({ name, folder, members }) {
    name = String(name ?? "").trim().slice(0, 40);
    if (!name) return { error: "Give the workplace a name." };
    if (list.some((w) => w.name.toLowerCase() === name.toLowerCase())) return { error: `There's already a workplace called "${name}".` };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workplace";
    const id = `${slug}-${randomUUID().slice(0, 4)}`;
    const target = String(folder ?? "").trim() || join(root, "workplaces", slug);
    const problem = checkFolder(target);
    if (problem) return { error: problem };
    const w = { id, name, folder: resolve(target), members: (members ?? []).filter((m) => KNOWN_WORKERS.includes(m)), created_at: Date.now() };
    list.push(w);
    save();
    start(w);
    announce();
    return { workplace: summary(w) };
  }

  // Take a workplace out of Trident. Its folder and files stay exactly where they are, and its
  // board and chat are kept on disk (archived), so nothing is lost by removing it.
  function remove(id) {
    const w = live.get(id);
    if (!w) return { error: "That workplace doesn't exist." };
    if (id === "main") return { error: "Main can't be removed. It's where Trident starts." };
    w.team.stopAll();
    w.lead.close();
    live.delete(id);
    list = list.filter((x) => x.id !== id);
    save();
    const archiveFile = join(dataDir, "workplaces-archived.json");
    let archived = [];
    try { archived = JSON.parse(readFileSync(archiveFile, "utf8")); } catch {}
    archived.push({ id: w.id, name: w.name, folder: w.folder, members: w.members, removed_at: Date.now() });
    writeFileSync(archiveFile, JSON.stringify(archived, null, 2));
    announce();
    return { folder: w.folder };
  }

  // Stop the current goal: workers stop, nothing more is merged, and the board says Cancelled.
  function cancelGoal(id) {
    const w = live.get(id);
    if (!w) return { error: "That workplace doesn't exist." };
    w.team.stopAll();
    if (!w.board.setGoalStatus("cancelled")) return { error: "There's no goal in progress to cancel." };
    emit({ type: "message", wp: id, agent: "team", text: "Goal cancelled. Workers stopped; anything already added to the folder stays." });
    return {};
  }

  for (const w of list) start(w);
  announce();

  return {
    get: (id) => live.get(id) ?? null,
    all: () => [...live.values()],
    create,
    remove,
    cancelGoal,
    announce,
  };
}
