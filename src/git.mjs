// Git plumbing for worker workspaces.
// The workspace folder is its own git repo. Each task gets a worktree (a second
// checkout on its own branch), so two workers never edit the same files at once.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Commits are made by Trident itself, so they carry a local name, not the user's.
const ID = ["-c", "user.name=Trident", "-c", "user.email=trident@localhost", "-c", "core.autocrlf=false"];

export function git(cwd, ...args) {
  return execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Commit everything in a folder; returns false when there was nothing to commit.
export function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  if (!git(cwd, "status", "--porcelain")) return false;
  git(cwd, "commit", "-q", "-m", message);
  return true;
}

export function ensureRepo(workspace) {
  if (!existsSync(join(workspace, ".git"))) {
    git(workspace, "init", "-q", "-b", "main");
    commitAll(workspace, "Trident: starting point") || git(workspace, "commit", "-q", "--allow-empty", "-m", "Trident: starting point");
  }
}

// A fresh worktree for one task, branched from the workspace as it is now.
export function createWorktree(workspace, root, name) {
  commitAll(workspace, `Trident: snapshot before ${name}`);
  mkdirSync(root, { recursive: true });
  const dir = join(root, name);
  const branch = `trident/${name}`;
  if (existsSync(dir)) return { dir, branch, base: git(dir, "merge-base", "HEAD", "main") };
  const base = git(workspace, "rev-parse", "HEAD");
  git(workspace, "worktree", "add", "-q", "-B", branch, dir, base);
  return { dir, branch, base };
}

// What the worker changed: a short file summary plus the full diff for the checker.
export function changes(dir, base) {
  commitAll(dir, "Trident: worker result");
  return {
    stat: git(dir, "diff", "--stat", base, "HEAD"),
    diff: git(dir, "diff", base, "HEAD"),
  };
}

// Bring an accepted task's branch into the workspace. On a conflict nothing changes.
export function mergeBranch(workspace, branch, message) {
  commitAll(workspace, "Trident: snapshot before merge");
  try {
    git(workspace, "merge", "--no-ff", "-q", "-m", message, branch);
    return null;
  } catch (err) {
    try { git(workspace, "merge", "--abort"); } catch {}
    return `It could not be merged automatically: ${String(err.stderr || err.message).split("\n")[0]}`;
  }
}

export function removeWorktree(workspace, dir) {
  try { git(workspace, "worktree", "remove", "--force", dir); } catch {}
}
