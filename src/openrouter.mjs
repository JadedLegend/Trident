// OpenRouter: any model it hosts, run inside the same Claude Agent SDK harness as the Claude worker
// (same tools, same approval gate), through OpenRouter's Anthropic-compatible endpoint.
//
// Setup (you type your key yourself; Trident never asks for it):
//   setx OPENROUTER_API_KEY "your-key"          optional: setx OPENROUTER_MODEL "vendor/model"
// then restart Trident.
import { execFileSync } from "node:child_process";

export const DEFAULT_MODEL = "qwen/qwen3-coder";

// Read a setting from this process, or from the Windows user environment (so `setx` works without a reboot).
function setting(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return out.trim();
  } catch {
    return "";
  }
}

export function openRouterConfig() {
  const key = setting("OPENROUTER_API_KEY");
  if (!key) return null;
  const model = setting("OPENROUTER_MODEL") || DEFAULT_MODEL;
  return {
    model,
    key,
    // Environment for the worker's Claude process. ANTHROPIC_API_KEY must be set and empty (OpenRouter's guide),
    // and every model slot points at the chosen model so nothing falls back to an Anthropic model.
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    },
    // Checks the key and the model without generating anything (no cost).
    async check() {
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, redirect: "error" });
      if (!r.ok) return `OpenRouter rejected the key (HTTP ${r.status}).`;
      const { data } = await r.json();
      const models = (await (await fetch("https://openrouter.ai/api/v1/models")).json()).data;
      const m = models.find((x) => x.id === model);
      if (!m) return `OpenRouter has no model "${model}" (renamed or retired). Set OPENROUTER_MODEL to another one.`;
      if (!(m.supported_parameters ?? []).includes("tools")) return `The model "${model}" cannot use tools, so it cannot edit files. Pick another one.`;
      if (data.limit_remaining != null && data.limit_remaining <= 0) return "Your OpenRouter key has no credit left.";
      return null;
    },
  };
}
