// Spike: talk to `codex app-server` over stdio (JSON-RPC, one JSON object per line).
// Measures startup and two turns on one long-lived thread.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const cwd = process.argv[2] ?? process.cwd();
const t0 = Date.now();
const ARGS = ["app-server", "--disable", "plugins", "--disable", "apps", "--disable", "hooks", "--disable", "memories", "--disable", "guardian_approval",
  ...["node_repl", "better-design", "graphify"].flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`])];
const p = spawn("codex", ARGS, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    p.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
let onTurnDone = null;
createInterface({ input: p.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(m.error) : res(m.result);
  } else if (m.id != null && m.method) {
    console.log(`[server asks] ${m.method}`, JSON.stringify(m.params).slice(0, 200));
    p.stdin.write(JSON.stringify({ id: m.id, result: { decision: "decline" } }) + "\n");
  } else if (m.method === "item/completed") {
    const it = m.params.item;
    console.log(`[item ${it.type}] ${Date.now() - t0}ms`, JSON.stringify(it).slice(0, 300));
  } else if (m.method && !m.method.includes("delta") && !m.method.startsWith("item/")) {
    if (m.method !== "turn/completed") console.log(`[note ${m.method}] ${Date.now() - t0}ms`, JSON.stringify(m.params).slice(0, 160));
  }
  if (m.method === "item/started") console.log(`[start ${m.params.item.type}] ${Date.now() - t0}ms`, JSON.stringify(m.params.item).slice(0, 200));
  if (m.method === "turn/completed") {
    console.log(`[turn done ${m.params.turn.status}] ${Date.now() - t0}ms`);
    onTurnDone?.();
  }
});

await call("initialize", { clientInfo: { name: "trident", title: "Trident", version: "0.1" }, capabilities: null });
p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
console.log(`initialized ${Date.now() - t0}ms`);
const { thread } = await call("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
console.log(`thread ${thread.id} ${Date.now() - t0}ms`);
for (const text of ["Reply with just the word ready.", "List the files in this folder, then reply with how many there are."]) {
  const done = new Promise((r) => (onTurnDone = r));
  const s = Date.now();
  await call("turn/start", { threadId: thread.id, effort: "medium", input: [{ type: "text", text, text_elements: [] }] });
  await done;
  console.log(`turn took ${Date.now() - s}ms`);
}
p.kill();
process.exit(0);
