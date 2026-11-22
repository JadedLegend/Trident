# How Band, Coral and PandaOS make agents work together

Studied 2026-11-19 from the installed copies on this PC. Coral's public source (commit 6eab1ea) was also read. Nothing was executed.

How each claim is known:
- **[doc]**: read in the app's own shipped docs.
- **[code]**: read in source or bundled JavaScript.
- **[inferred]**: my reading of the evidence; not verified.

## At a glance

| | Band | Coral | PandaOS |
|---|---|---|---|
| Built with | Rust/Tauri desktop app plus a `jamd` daemon [doc: band-peer AGENTS.md] | Go: 10 small exes [code] | Electron, v1.2.1 [code: package.json] |
| How it drives agents | Official CLIs; Claude Code hooks; ACP for others [doc] | CLIs in a PTY or tmux, plus injected hooks [code] | **Vendor SDKs** called directly: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk` [code: package.json] |
| Collaboration model | **Chat rooms**: agents only hear `@mentions` and hand off by mentioning each other | **Team board plus task queue**: goals, tasks with dependencies, required outputs | **One Director plus worker sessions**: the Director routes, and sessions do the work |
| Who decides the next step | The agents themselves, by @mentioning the next agent | Agents claim tasks; an optional Orchestrator role reviews and completes them | The Director only. Delegate-only is the default [code: index.js:1936] |
| Human approvals | Per request: allow once, deny, allow always, deny always [doc: user-guide.md:464] | "Needs you" inbox; only the Operator grants anything [doc: chief.md] | The Director relays session questions and approvals to you [code: index.js:~68230] |

## Band: a chat room where the agents @mention each other
- **Core rule:** agents only receive messages that `@mention` them. To hand off, one agent mentions the next ("ask @reviewer to review") [doc: user-guide.md:7-22, 76-88].
- **Assigning vs messaging:** assigning work creates a tracked task (To do → Done); sending a message is just talk [doc: user-guide.md:7-22].
- **How messages reach a Claude Code session:** a long-running `band receive --lease` monitor plus a hook on every Claude Code event (PreToolUse, Stop, and so on). The hooks report activity to the daemon and must never block the session [code: hooks.json; doc: AGENTS.md "Hook safety"].
- **The "intelligence" lives in role prompts.** The architect skill tells it to review adversarially, verify against the real code and run the full test gate; the developer skill tells it to build test-first and prove the work [doc: skills/architect, skills/full-stack-developer].
- **Teams are preset role bundles.** "Delivery" has a manager, planner, plan reviewer, implementer and implementation reviewer, and **only the manager talks to you** [doc: user-guide.md:371-397].
- **Weakness [inferred]:** nobody owns the overall plan unless you add a manager. Without one, the collaboration is only as smart as each agent's choice of whom to mention next.

## Coral: a team board with a task queue and proof of completion
- **Building blocks:** Team → Goal (with one checkable **"Done when"** line) → Tasks (priority, owner, dependencies, required artifacts) [doc: key-concepts.md].
- **How messages reach an agent:** `coral-hook-message-check` runs after every tool call and prints "you have N unread" into the agent's context. It doesn't repeat that line until new messages arrive [code: cmd/coral-hook-message-check/main.go:1-3, 94-113].
- **Task mirroring:** `coral-hook-task-sync` copies each agent's own task updates (TaskCreate/TaskUpdate) onto the dashboard [code: cmd/coral-hook-task-sync/main.go:1-3].
- **Proof of completion:** a worker submits a *candidate* with artifacts, and only the Orchestrator accepts it. Nothing is accepted automatically [doc: completion-review.md].
- **"Chief" relay agent:** a front agent that talks to you in plain words and relays to the dev team. It never claims you approved something you didn't [doc: chief.md].
- **Coordination reports:** a read-only tool flags friction such as duplicate work, agents active without progress, and churn [doc: coordination-reporting.md].
- **Weakness [inferred]:** it's heavy. The board doc alone is 141 KB, so there are a lot of concepts to learn before getting value.

## PandaOS: a Director that routes work, plus a voice-first interface
- **The Director** is a top-level agent that "observes and routes work across sessions". Code and commands are always handed to sessions, and the Director reports back [code: index.js:68177].
- **Every turn starts with a `[state]` block** listing your sessions, their status and pending approvals. That lets it answer "status?" without any tool calls [code: index.js:~68190].
- **Delegation works differently per backend** [code: index.js:43466-43520]:
  - Claude and OpenCode use their own native Task tool.
  - Codex uses a custom `spawn_team_member` tool, because Codex's native spawn "cannot carry the member's identity or model".
- **A delegated member is told to return its result, not dispatch other members.** "Let the orchestrator decide what happens next." [code: index.js:49574]
- **Design focus:** voice first, with a "stage" that arranges what you see; it's also tied into Gmail, Calendar, Supabase and Vercel [code: index.js:~68200].
- **Weakness [inferred]:** a single router. The workers don't review each other; it's hub and spoke, not a team.

## What this means for your app

None of the three really combines **a planner that owns the goal** with **workers who check each other's work** and **a simple interface**. Ideas worth taking from each:

1. **From PandaOS:** one lead agent (the Director) that owns the plan and is the only one talking to you, with a `[state]` snapshot injected every turn.
2. **From Coral:** a goal with one checkable "Done when" line, and completion that needs a candidate plus evidence and an independent accept.
3. **From Band:** handoffs through @mentions in a visible room, so you can watch them, and approval choices of allow once, deny, allow always and deny always.
4. **From PandaOS:** drive the agents with the **vendor SDKs** (Claude Agent SDK, Codex SDK), not by screen-scraping a terminal. You get structured events and tool calls, and the agents still sign in with your plans.

**Not yet checked:** I didn't run any of the three. Band's daemon and desktop binaries weren't disassembled (the docs were enough), and PandaOS's 21 MB interface bundle wasn't read.
