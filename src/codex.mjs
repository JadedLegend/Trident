// Codex, through one long-lived `codex app-server` process (JSON-RPC over stdio).
// Starting it once avoids the ~70s cost per turn of the one-shot SDK mode.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep Trident's Codex free of the user's global plugins and MCP servers:
// they add ~35s to every start and some of them fail to sign in.
function isolationArgs() {
  const args = [];
  for (const f of ["plugins", "apps", "hooks", "memories", "guardian_approval"]) args.push("--disable", f);
  let config = "";
  try { config = readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), "utf8"); } catch {}
  for (const [, name] of config.matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)) args.push("-c", `mcp_servers.${name}.enabled=false`);
  return args;
}

// Codex's own error text is long and includes upgrade offers; reduce it to one plain line.
function plainError(msg) {
  if (/usage limit/i.test(msg)) {
    const when = msg.match(/try again (?:at|after|in) ([^.]+)/i)?.[1];
    return { text: `Codex is out of usage${when ? ` until ${when.trim()}` : " for now"}.`, outOfUsage: true, when };
  }
  return { text: msg.split("\n")[0].slice(0, 200), outOfUsage: false };
}

export function startCodex({ emit }) {
  let unavailable = null; // { until, reason } while Codex is out of usage
  let proc = null;
  let ready = null;
  let nextId = 1;
  const pending = new Map(); // our requests waiting for a reply
  const threads = new Map(); // threadId -> handlers for that thread's events

  function start() {
    proc = spawn("codex", ["app-server", ...isolationArgs()], { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    proc.stderr.on("data", () => {}); // Codex logs noise here; ignore it.
    proc.on("exit", (code) => {
      for (const { rej } of pending.values()) rej(new Error(`Codex stopped (exit ${code})`));
      pending.clear();
      for (const h of threads.values()) h.onExit?.();
      proc = null;
      ready = null;
    });
    createInterface({ input: proc.stdout }).on("line", onLine);
    ready = (async () => {
      await request("initialize", { clientInfo: { name: "trident", title: "Trident", version: "0.3" }, capabilities: null });
      send({ method: "initialized" });
    })();
    return ready;
  }

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
  function request(method, params) {
    return new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ id, method, params });
    });
  }

  function onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      return m.error ? p.rej(new Error(m.error.message ?? JSON.stringify(m.error))) : p.res(m.result);
    }
    const h = threads.get(m.params?.threadId);
    if (m.id != null && m.method) {
      // Codex is asking permission. Unknown requests are declined.
      Promise.resolve(h?.onRequest?.(m.method, m.params) ?? { decision: "decline" })
        .then((result) => send({ id: m.id, result }))
        .catch(() => send({ id: m.id, result: { decision: "decline" } }));
      return;
    }
    if (h) h.onEvent?.(m.method, m.params);
  }

  // One conversation with Codex. `run(text)` resolves with Codex's final message for that turn.
  async function thread({ cwd, sandbox = "workspace-write", onRequest, onItem }) {
    await (ready ?? start());
    const { thread } = await request("thread/start", { cwd, sandbox, approvalPolicy: "untrusted", approvalsReviewer: "user", ephemeral: true });
    let finish = null;
    let last = "";
    let lastError = "";
    threads.set(thread.id, {
      onRequest,
      onExit: () => finish?.reject(new Error("Codex stopped")),
      onEvent(method, params) {
        if (method === "error") lastError = params.error?.message ?? "";
        if (method === "item/completed") {
          if (params.item.type === "agentMessage") last = params.item.text;
          onItem?.(params.item);
        } else if (method === "turn/completed") {
          const t = params.turn;
          if (t.status === "completed") finish?.resolve(last);
          else {
            const e = plainError(t.error?.message || lastError || `Codex turn ${t.status}`);
            if (e.outOfUsage) {
              // "Nov 22nd, 2026 12:30 AM" -> drop the "nd" so it parses; unknown times retry in 30 minutes.
              const until = Date.parse((e.when ?? "").replace(/(\d)(st|nd|rd|th)/, "$1")) || Date.now() + 30 * 60 * 1000;
              unavailable = { until, reason: e.text };
              emit({ type: "status", agent: "codex", state: "unavailable", reason: e.text });
            }
            finish?.reject(new Error(e.text));
          }
        }
      },
    });
    return {
      id: thread.id,
      async run(text, { outputSchema } = {}) {
        last = "";
        const done = new Promise((resolve, reject) => (finish = { resolve, reject }));
        await request("turn/start", { threadId: thread.id, effort: "medium", outputSchema: outputSchema ?? null, input: [{ type: "text", text, text_elements: [] }] });
        return done;
      },
      interrupt: (turnId) => request("turn/interrupt", { threadId: thread.id, turnId }).catch(() => {}),
      close: () => threads.delete(thread.id),
    };
  }

  // Why Codex cannot take work right now, or null when it can (it is tried again once the wait is over).
  function unavailableReason() {
    if (unavailable && Date.now() > unavailable.until) {
      unavailable = null;
      emit({ type: "status", agent: "codex", state: "idle" });
    }
    return unavailable?.reason ?? null;
  }

  return { thread, unavailableReason, stop: () => proc?.kill() };
}
