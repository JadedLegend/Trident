// End-to-end test: plan -> approve -> workers -> cross-check -> accept -> finish, in one workplace.
// Approves the plan and allows each approval, logging everything, including team talk.
// Usage: node spikes/e2e-team.mjs "<request>" [workplace-id]   (default workplace: main)
const BASE = "http://127.0.0.1:4317";
const WP = process.argv[3] ?? "main";
const post = (p, d) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wp: WP, ...(d ?? {}) }) });
const start = Date.now();
const t = () => `${Math.round((Date.now() - start) / 1000)}s`;

const res = await fetch(BASE + "/events");
const reader = res.body.getReader();
let buf = "";
let skipping = true; // ignore replayed history
setTimeout(() => (skipping = false), 1500);
setTimeout(() => post("/message", { text: process.argv[2] }), 2000);
const deadline = Date.now() + 30 * 60 * 1000;
let approved = false;
for (;;) {
  if (Date.now() > deadline) { console.log("TIMEOUT"); process.exit(1); }
  const { value, done } = await reader.read();
  if (done) break;
  buf += new TextDecoder().decode(value);
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!line.startsWith("data: ")) continue;
    const e = JSON.parse(line.slice(6));
    if (skipping || e.type === "delta" || (e.wp && e.wp !== WP)) continue;
    if (e.type === "board") {
      console.log(t(), "BOARD", e.goal?.status, e.tasks.map((x) => `${x.num}:${x.status}${x.owner !== "lead" ? "/" + x.owner : ""}${x.check_verdict ? "[" + x.check_by + ":" + x.check_verdict + "]" : ""}`).join(" | "));
      if (e.goal?.status === "proposed" && !approved) { approved = true; setTimeout(() => post("/plan/approve"), 1000); }
      if (e.goal?.status === "done") setTimeout(() => process.exit(0), 60000);
    } else if (e.type === "message") console.log(t(), "MSG", e.agent + ":", e.text.slice(0, 400));
    else if (e.type === "talk") console.log(t(), "TALK", `[${e.kind}] ${e.from_who}${e.to_who ? "->" + e.to_who : ""}: ${e.text.slice(0, 300)}`);
    else if (e.type === "tool") console.log(t(), "TOOL", e.agent, e.toolName, String(e.summary).slice(0, 120));
    else if (e.type === "status") console.log(t(), "STATUS", e.agent, e.state, e.task ?? "");
    else if (e.type === "approval") { console.log(t(), "APPROVAL", e.agent, e.toolName, e.summary.slice(0, 160)); post("/approval", { id: e.id, decision: "allow" }); }
    else if (e.type === "error") console.log(t(), "ERROR", e.text);
  }
}
