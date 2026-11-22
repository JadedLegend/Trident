# Design: a personal multi-agent workspace (working name "Trident")

For: one user on one Windows PC. Built on: [agent-collab-teardown.md](agent-collab-teardown.md).

## The problem
The apps you tried either collaborate poorly, with agents taking turns instead of building on each other's work, or have an interface that's hard to follow. Trident's goal is that you state what you want once, a **lead agent** runs the team, the agents **check each other's work across vendors**, and you only hear about decisions and results.

## How a piece of work flows

```
You ──ask──▶ Lead
              │ writes: Goal + "Done when" + task plan (owner, outputs, depends-on)
              ▼
         You approve the plan  (one click; or edit it)
              │
      ┌───────┴────────┐
   Worker A          Worker B        each in its own git worktree
   (Claude)          (Codex)
      │ submit candidate + evidence (diff, test output, notes)
      ▼
   Checker = the OTHER vendor reviews it  ── finds problems ──▶ back to worker
      │ passes
      ▼
   Lead accepts → merges one at a time → checks "Done when" → reports to you
```

Three rules make it "intelligent":
1. **One owner.** The lead owns the goal and the plan, and it's the only agent that talks to you (Band's manager and PandaOS's Director). Workers return results to the lead and never dispatch each other (PandaOS rule, index.js:49574).
2. **A checkable finish line.** Every goal has one "Done when" statement, and a task's result is only a *candidate* until someone accepts it (Coral).
3. **Cross-checking.** Claude's work is reviewed by Codex and Codex's by Claude. The two have different blind spots, which is the point of having both.

## Pieces

| Piece | What it does | Built with |
|---|---|---|
| **Engine** (background program) | Runs agents, stores everything, enforces the rules above | Node.js + TypeScript |
| **Agent adapters** | Start or resume a Claude or Codex agent, stream its events, stop it | Claude Agent SDK, Codex SDK. Both use the CLI logins you already have (PandaOS does the same). |
| **Team tools** | Tools every agent gets: `post_update`, `submit_result`, `request_review`, `ask_user`, `read_board` | A small MCP server inside the engine |
| **Board store** | Goals, tasks, messages, approvals, and history | SQLite (one file) |
| **Workspaces** | One git worktree per worker, merged one at a time | git |
| **Approval gate** | Any risky command or file write waits for you: allow once, deny, always allow, always deny (Band's model) | SDK permission callbacks |
| **Status snapshot** | Each lead turn opens with a short `[state]` block: tasks, who's working, what's waiting on you | Engine (from PandaOS) |
| **Interface** | A local web page at `localhost` | React |

## Interface: simple on purpose

```
┌──────────────────────────────────────────────────────────────┐
│  NEEDS YOU (2)   ▸ Approve plan for "Add login page"  ▸ ...   │
├──────────────────────┬───────────────────────────────────────┤
│  Chat with Lead      │  Goal: Add login page                 │
│                      │  Done when: user can sign in and the  │
│  you: add a login…   │  tests pass                           │
│  lead: here's the    │                                       │
│  plan (3 tasks)…     │  ● Build form        Claude  checking │
│                      │  ○ API route         Codex   working  │
│                      │  ○ Tests             Claude  waiting  │
│                      │                                       │
│  [ type here ]       │  ▸ Activity (collapsed by default)    │
└──────────────────────┴───────────────────────────────────────┘
```
- The left side is the only conversation you have, with the lead.
- The right side is the board: the goal, its tasks and their status in plain words.
- Raw agent activity (tool calls, thinking) stays collapsed unless you open it, so you don't get the wall of terminal text the other apps show.
- The **Needs you** bar is the only place a question or approval appears.

## Build order (each step is usable)
1. **M1: one agent, one chat.** The engine and interface talk to the lead (Claude) through the SDK, with live streaming and the approval gate. *Proves the plumbing.*
2. **M2: board and plan.** The lead writes a goal, a "Done when" line and tasks; you approve the plan; the board shows it.
3. **M3: two workers and a cross-check.** Add Codex, give each worker its own worktree, and add the candidate → checker → accept loop.
4. **M4: merge and finish.** Merge results one at a time, check "Done when", and give you a final report.
5. **Later:** more vendors (Gemini, Copilot), templates for common jobs, a phone view.

## Open questions
- **Lead model:** Claude as lead is my default. Do you want to be able to switch?
- **How much freedom:** should workers edit files without asking, inside their own worktree? My suggestion is yes, but commands and anything outside the worktree always ask.
- **Where it lives:** a new folder (for example `Desktop\Trident`) with its own git repo.

## What I'll verify before building
- That the Claude Agent SDK and Codex SDK both run with your existing logins on Windows. A 10-minute spike for each.
- What exact permission-callback options each SDK offers.

Since you can open any app at any time: while building, I'll ask you for screenshots of particular screens in Band, Coral or PandaOS when we need to see how they solved a UI problem.
