// Trident engine: a local web server on 127.0.0.1 only.
//   GET  /            the interface
//   GET  /events      live updates for every workplace (server-sent events); replays history on connect
//   POST /workplaces  { name, folder?, members? }   make a new workplace
//   POST /message     { wp, text }                 send a message to that workplace's Lead
//   POST /approval    { id, decision }             answer a pending approval
//   POST /plan/approve { wp }                       approve the plan waiting on that workplace's board
//   POST /interrupt   { wp }                       stop that Lead's current turn
//   POST /library/read|save|discard|write|restore|old/delete   the shared Library (see library.mjs)
//   POST /settings    { maxAgents }                change Trident-wide settings
import { createServer } from "node:http";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "./gate.mjs";
import { startCodex } from "./codex.mjs";
import { openRouterConfig } from "./openrouter.mjs";
import { openWorkplaces } from "./workplaces.mjs";
import { openLibrary } from "./library.mjs";
import { openSettings } from "./settings.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const PORT = Number(process.env.PORT ?? 4317);
mkdirSync(dataDir, { recursive: true });

// Everything that happens is an event: kept for replay, logged to disk, pushed to open pages.
// Events from a workplace carry its id as `wp`; events without one belong to every workplace.
const history = [];
const clients = new Set();
const transcript = join(dataDir, "transcript.jsonl");
function emit(event) {
  const e = { ...event, at: Date.now() };
  if (e.type !== "delta") {
    history.push(e);
    appendFileSync(transcript, JSON.stringify(e) + "\n");
  }
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) res.write(line);
}

const gate = createGate({ rulesFile: join(dataDir, "rules.json"), emit });
const openrouter = openRouterConfig(); // null until OPENROUTER_API_KEY is set
const codex = startCodex({ emit });
const library = openLibrary({ dir: join(root, "library"), emit });
const settings = openSettings({ file: join(dataDir, "settings.json"), emit });
const workplaces = openWorkplaces({ root, dataDir, emit, gate, codex, openrouter, library, settings });
library.changed();
settings.announce();
// Check the OpenRouter key and model once at startup, without generating anything.
openrouter?.check().then((problem) => problem && emit({ type: "error", agent: "openrouter", text: problem })).catch(() => {});

const html = () => readFileSync(join(root, "public", "index.html"));

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  try {
    const send = (code, text) => res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(text ?? "");
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html());
    } else if (req.method === "GET" && req.url === "/ember.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(readFileSync(join(root, "public", "ember.css")));
    } else if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 25000); // stops idle connections from timing out
      req.on("close", () => clearInterval(beat));
      req.on("close", () => clients.delete(res));
    } else if (req.method === "POST" && req.url === "/workplaces") {
      const r = workplaces.create(await body(req));
      if (r.error) return send(400, r.error);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(r.workplace));
    } else if (req.method === "POST" && req.url === "/workplaces/remove") {
      const r = workplaces.remove((await body(req)).wp);
      if (r.error) return send(400, r.error);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
    } else if (req.method === "POST" && req.url === "/goal/cancel") {
      const r = workplaces.cancelGoal((await body(req)).wp);
      send(r.error ? 400 : 204, r.error);
    } else if (req.method === "POST" && req.url.startsWith("/library/")) {
      const d = await body(req);
      const action = req.url.slice("/library/".length);
      const r =
        action === "read" ? library.read(d.path) :
        action === "save" ? library.save(d.path) :
        action === "discard" ? library.discard(d.path) :
        action === "write" ? library.draft(d.path, String(d.text ?? ""), "you", d.why ?? "") :
        action === "restore" ? library.restore(d.path) :
        action === "old/delete" ? library.deleteOld(d.path) :
        action === "refresh" ? (library.changed(), {}) :
        { error: "Unknown Library action." };
      if (r.error) return send(400, r.error);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r));
    } else if (req.method === "POST" && req.url === "/settings") {
      const r = settings.set(await body(req));
      if (r.error) return send(400, r.error);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.settings));
    } else if (req.method === "POST" && req.url === "/approval") {
      const { id, decision } = await body(req);
      const ok = ["allow", "deny", "always-allow", "always-deny"].includes(decision) && gate.decide(id, decision);
      send(ok ? 204 : 404);
    } else if (req.method === "POST" && ["/message", "/plan/approve", "/interrupt"].includes(req.url)) {
      const data = await body(req);
      const w = workplaces.get(data.wp ?? "main");
      if (!w) return send(404, "No such workplace.");
      const emitWp = (e) => emit({ ...e, wp: w.id });
      if (req.url === "/message") {
        const text = String(data.text ?? "").trim();
        if (!text) return send(400, "empty");
        emitWp({ type: "message", agent: "you", text });
        w.lead.send(text);
      } else if (req.url === "/plan/approve") {
        if (w.board.snapshot().goal?.status !== "proposed") return send(409, "no plan waiting");
        w.board.setGoalStatus("active");
        emitWp({ type: "message", agent: "you", text: "Approved the plan." });
        w.lead.send("I approve the plan. Start the work.");
      } else {
        await w.lead.interrupt();
      }
      send(204);
    } else {
      send(404);
    }
  } catch (err) {
    res.writeHead(500).end(String(err?.message ?? err));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Trident running at http://127.0.0.1:${PORT}`));
