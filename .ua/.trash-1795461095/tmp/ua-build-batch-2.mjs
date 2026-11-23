import { writeFileSync, readFileSync } from "node:fs";
const OUT = "C:/Users/aLLIEDiNTENT/Desktop/TridentIGuess/Trident/.ua/intermediate/batch-2.json";
const F = (p, summary, tags, complexity, languageNotes) => ({ id: `file:${p}`, type: "file", name: p.split("/").pop(), filePath: p, summary, tags, complexity, ...(languageNotes ? { languageNotes } : {}) });
const Fn = (p, name, lineRange, summary, tags, complexity) => ({ id: `function:${p}:${name}`, type: "function", name, filePath: p, lineRange, summary, tags, complexity });
const nodes = [
  F("src/codex.mjs", "Codex worker adapter that keeps one long-lived codex app-server process running and talks to it over JSON-RPC on stdio, giving the rest of Trident per-thread conversations, approval forwarding and out-of-usage tracking.", ["service", "agent-adapter", "json-rpc", "child-process", "codex"], "moderate", "Uses a closure-based module (a factory function returning methods) instead of a class, with a Map of pending request promises keyed by JSON-RPC id."),
  Fn("src/codex.mjs", "startCodex", [29, 138], "Factory that lazily spawns the Codex app-server in isolation mode (global plugins and MCP servers disabled), routes JSON-RPC replies, events and permission requests to per-thread handlers, and exposes thread(), unavailableReason() and stop().", ["factory", "agent-adapter", "json-rpc", "event-handler"], "complex"),
  F("src/library.mjs", "The shared Markdown Library: a plain folder of notes in sections that every agent can read, where every change is first stored as a draft and only becomes the real note when the user saves it, with replaced versions kept under .old.", ["service", "storage", "markdown", "drafts", "versioning"], "moderate"),
  Fn("src/library.mjs", "openLibrary", [33, 168], "Creates the Library folders and default guide, then returns snapshot, list, read, draft, save, discard, restore and deleteOld operations; paths are cleaned to stay inside the Library, and every change emits a library update event.", ["factory", "storage", "validation", "versioning"], "complex"),
  F("src/openrouter.mjs", "OpenRouter integration that reads the API key and model from the process or Windows user environment and builds the environment that points the Claude Agent SDK worker at OpenRouter's Anthropic-compatible endpoint, plus a no-cost key and model check.", ["config", "integration", "openrouter", "environment"], "moderate"),
  Fn("src/openrouter.mjs", "setting", [12, 21], "Reads a named setting from process.env, falling back to the Windows user environment through PowerShell so values set with setx work without a reboot.", ["utility", "environment", "windows"], "simple"),
  Fn("src/openrouter.mjs", "openRouterConfig", [23, 57], "Returns null when no OpenRouter key is set; otherwise returns the model, key, an env override mapping every Anthropic model slot to the chosen model, and check(), which verifies the key, model existence, tool support and remaining credit.", ["factory", "config", "validation", "integration"], "moderate"),
  F("src/server.mjs", "Trident's entry point: a local HTTP server bound to 127.0.0.1 that wires together the gate, Codex, OpenRouter, Library, settings and workplaces, streams every event to the page over server-sent events, and handles the POST routes for workplaces, messages, approvals, plans, interrupts, Library actions and settings.", ["entry-point", "api-handler", "http-server", "server-sent-events", "composition-root"], "moderate", "Uses Node's built-in http module with a hand-written if/else router instead of a framework, and an in-memory history array replayed to each new SSE client."),
  Fn("src/server.mjs", "emit", [32, 40], "Central event bus: timestamps an event, keeps non-delta events in history and the JSONL transcript, and pushes it to every connected server-sent-events client.", ["event-handler", "logging", "server-sent-events"], "simple"),
  F("src/settings.mjs", "Trident-wide settings store kept in data/settings.json, currently holding the maximum number of workers per workplace, with validation and a settings event on every change.", ["config", "storage", "settings", "validation"], "simple"),
  Fn("src/settings.mjs", "openSettings", [6, 24], "Loads settings over defaults from the JSON file and returns get, announce and set; set checks that maxAgents is between 1 and 10, writes the file and emits the new settings.", ["factory", "config", "validation"], "simple"),
];
const E = (source, target, type, weight) => ({ source, target, type, direction: "forward", weight });
const edges = [];
for (const n of nodes) if (n.type === "function") {
  edges.push(E(`file:${n.filePath}`, n.id, "contains", 1.0));
  if (!["setting", "emit"].includes(n.name)) edges.push(E(`file:${n.filePath}`, n.id, "exports", 0.8));
}
for (const t of ["src/codex.mjs", "src/gate.mjs", "src/library.mjs", "src/openrouter.mjs", "src/settings.mjs", "src/workplaces.mjs"]) edges.push(E("file:src/server.mjs", `file:${t}`, "imports", 0.7));
for (const t of ["function:src/codex.mjs:startCodex", "function:src/openrouter.mjs:openRouterConfig", "function:src/library.mjs:openLibrary", "function:src/settings.mjs:openSettings", "function:src/gate.mjs:createGate", "function:src/workplaces.mjs:openWorkplaces"]) edges.push(E("file:src/server.mjs", t, "calls", 0.8));
edges.push(E("function:src/openrouter.mjs:openRouterConfig", "function:src/openrouter.mjs:setting", "calls", 0.8));
const ids = new Set(nodes.map((n) => n.id));
const ext = new Set(["file:src/gate.mjs", "file:src/workplaces.mjs", "function:src/gate.mjs:createGate", "function:src/workplaces.mjs:openWorkplaces"]);
for (const e of edges) for (const x of [e.source, e.target]) if (!ids.has(x) && !ext.has(x)) throw new Error("bad edge " + x);
if (ids.size !== nodes.length) throw new Error("duplicate ids");
writeFileSync(OUT, JSON.stringify({ nodes, edges }, null, 2));
JSON.parse(readFileSync(OUT, "utf8"));
console.log("nodes", nodes.length, "edges", edges.length, "imports", edges.filter((e) => e.type === "imports").length);
