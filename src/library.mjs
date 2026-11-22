// The Library: one shared shelf of plain-text notes (Markdown) that every agent in every workplace can read.
//
//   library/guide.md             read by every model when it starts in Trident
//   library/<section>/<name>.md  skills and notes, sorted into sections (frontend, music, ideas, ...)
//   library/.drafts/...          changes agents made, waiting for the user to press Save
//   library/.old/...             the version each Save replaced, so nothing is lost
//
// Agents can change anything, but only as drafts. A draft becomes the real note only when the user saves it.
// Because it is a plain folder, Obsidian or Joplin can open or import it too.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";

const SECTIONS = ["frontend", "backend", "music", "ideas", "research"];

const GUIDE = `# Welcome to Trident

You're stepping into a shared studio. Other models work here too, and so does the person who built it.
This page is how we start: one way of standing here, not a rulebook.

## Four motions

- **Remember.** The Library holds what has been learned so far. Look there before starting from nothing.
- **Checkpoint.** Before you stop to wait for an approval or an answer, note where you are and what comes next, so you can pick the thread back up without starting over.
- **Recover.** A run that fails isn't thrown away. Say what went wrong and what you'd try next; that is something learned.
- **Condense.** When something useful comes out of the work, keep it short and dense, so the next reader gets the most for the least effort.

## The Library

The Library has sections (frontend, backend, music, ideas, research). Any note in it, this guide included, can be improved.
When you change a note, it becomes a draft. The person decides what gets saved, and the old version is always kept.
`;

export function openLibrary({ dir, emit }) {
  const drafts = join(dir, ".drafts");
  const old = join(dir, ".old");
  const draftIndex = join(drafts, "index.json");
  for (const d of [dir, drafts, old, ...SECTIONS.map((s) => join(dir, s))]) mkdirSync(d, { recursive: true });
  if (!existsSync(join(dir, "guide.md"))) writeFileSync(join(dir, "guide.md"), GUIDE);

  const index = () => { try { return JSON.parse(readFileSync(draftIndex, "utf8")); } catch { return {}; } };
  const saveIndex = (i) => writeFileSync(draftIndex, JSON.stringify(i, null, 2));

  // A note's path inside the Library, like "music/mixing.md". Returns null for anything outside it.
  function clean(p) {
    let rel = normalize(String(p ?? "").trim()).split(sep).join("/").replace(/^\/+/, "");
    if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.startsWith(".")) return null;
    if (!rel.endsWith(".md")) rel += ".md";
    if (!/^[\w\- ./]+$/.test(rel)) return null;
    return rel;
  }
  const real = (rel) => join(dir, ...rel.split("/"));
  const readOr = (f, fallback = null) => { try { return readFileSync(f, "utf8"); } catch { return fallback; } };
  const titleOf = (text, rel) => text?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel.split("/").pop().replace(/\.md$/, "");
  const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

  function walk(base, prefix = "") {
    const out = [];
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) out.push(...walk(join(base, e.name), rel + "/"));
      else if (e.name.endsWith(".md")) out.push(rel);
    }
    return out;
  }

  // Everything the screen needs to draw the Library.
  function snapshot() {
    const i = index();
    const notes = walk(dir).map((rel) => ({ path: rel, title: titleOf(readOr(real(rel)), rel), draft: !!i[rel] }));
    for (const [rel] of Object.entries(i)) if (!notes.some((n) => n.path === rel)) notes.push({ path: rel, title: titleOf(readOr(join(drafts, ...rel.split("/"))), rel), draft: true, isNew: true });
    const sections = [...new Set([...SECTIONS, ...notes.map((n) => (n.path.includes("/") ? n.path.split("/")[0] : "")).filter(Boolean)])];
    // When it was replaced comes from the name ("--20261122-170500"); a copied file keeps the original's file date.
    const replacedAt = (rel) => {
      const m = rel.match(/--(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/);
      return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : statSync(join(old, ...rel.split("/"))).mtimeMs;
    };
    const oldVersions = existsSync(old) ? walk(old).map((rel) => ({ path: rel, at: replacedAt(rel) })).sort((a, b) => b.at - a.at) : [];
    return { sections, notes, drafts: Object.entries(i).map(([path, d]) => ({ path, ...d })), old: oldVersions };
  }
  const changed = () => emit({ type: "library", ...snapshot() });

  function keepOld(rel) {
    const f = real(rel);
    if (!existsSync(f)) return;
    const dest = join(old, ...`${rel.replace(/\.md$/, "")}--${stamp()}.md`.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f, dest);
  }

  return {
    snapshot,
    changed,
    guide: () => readOr(join(dir, "guide.md"), ""),
    list: () => snapshot().notes.map((n) => `${n.path} — ${n.title}${n.draft ? " (has an unsaved draft)" : ""}`).join("\n"),

    read(p) {
      const rel = clean(p);
      if (!rel) return { error: "That isn't a Library note." };
      const text = readOr(real(rel));
      const draft = readOr(join(drafts, ...rel.split("/")));
      if (text === null && draft === null) return { error: `There's no note called ${rel}.` };
      return { path: rel, text, draft, draftInfo: index()[rel] ?? null };
    },

    // An agent's (or the user's) change. It waits as a draft until the user saves it.
    draft(p, text, by, why = "") {
      const rel = clean(p);
      if (!rel) return { error: "Use a path like music/mixing.md." };
      const f = join(drafts, ...rel.split("/"));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, String(text));
      const i = index();
      i[rel] = { by, why: String(why).slice(0, 300), at: Date.now() };
      saveIndex(i);
      changed();
      return { path: rel };
    },

    // The user pressed Save: the old version goes to .old, the draft becomes the note.
    save(p) {
      const rel = clean(p);
      const f = rel && join(drafts, ...rel.split("/"));
      if (!rel || !existsSync(f)) return { error: "There's no draft to save." };
      keepOld(rel);
      mkdirSync(dirname(real(rel)), { recursive: true });
      renameSync(f, real(rel));
      const i = index();
      delete i[rel];
      saveIndex(i);
      changed();
      return { path: rel };
    },

    discard(p) {
      const rel = clean(p);
      if (!rel) return { error: "That isn't a Library note." };
      rmSync(join(drafts, ...rel.split("/")), { force: true });
      const i = index();
      delete i[rel];
      saveIndex(i);
      changed();
      return {};
    },

    // Bring an old version back as a draft, so it still goes through Save.
    restore(oldPath, by = "you") {
      const rel = clean(oldPath);
      const text = rel && readOr(join(old, ...rel.split("/")));
      if (text === null || !rel) return { error: "That old version isn't there anymore." };
      return this.draft(rel.replace(/--\d{8}-\d{6}\.md$/, ".md"), text, by, "Brought back an old version");
    },

    // Delete one old version, or all of them ("all"). These are gone for good.
    deleteOld(p) {
      if (p === "all") {
        rmSync(old, { recursive: true, force: true });
        mkdirSync(old, { recursive: true });
      } else {
        const rel = clean(p);
        if (!rel) return { error: "That isn't an old version." };
        rmSync(join(old, ...rel.split("/")), { force: true });
      }
      changed();
      return {};
    },
  };
}
