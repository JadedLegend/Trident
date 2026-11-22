// Trident-wide settings the user changes on the Settings screen, kept in data/settings.json.
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULTS = { maxAgents: 3 }; // how many workers may be working at the same moment, per workplace

export function openSettings({ file, emit }) {
  let s = { ...DEFAULTS };
  try { s = { ...s, ...JSON.parse(readFileSync(file, "utf8")) }; } catch {}
  const announce = () => emit({ type: "settings", settings: s });
  return {
    get: () => s,
    announce,
    set(changes) {
      if ("maxAgents" in changes) {
        const n = Math.round(Number(changes.maxAgents));
        if (!(n >= 1 && n <= 10)) return { error: "Pick a number from 1 to 10." };
        s.maxAgents = n;
      }
      writeFileSync(file, JSON.stringify(s, null, 2));
      announce();
      return { settings: s };
    },
  };
}
