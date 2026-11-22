# Trident

A personal multi-agent workspace that runs on your own computer. You say what you want once; a team of AI models from different companies plans it, builds it, checks each other's work, and shows you only what needs your decision.

It runs as a small local web page at `http://127.0.0.1:4317`, visible only on your machine.

## What it does

- **A Lead that plans.** Ask for something and the Lead writes a plan: the goal, one checkable "Done when" line, and short tasks with an owner each. Nothing starts until you approve it.
- **Workers from different vendors.** Claude, Codex, and any model on OpenRouter can take tasks. Each works in its own copy of the project (a git worktree), so they never trip over each other.
- **Cross-checking.** When a worker finishes, a model from a *different* company reviews it. Different models have different blind spots, which is the point.
- **Team talk.** Agents can message each other and the Lead while they work. Messages never interrupt anyone; they're read the next time an agent looks, so nobody gets stuck waiting.
- **Workplaces.** Separate studios, each with its own folder, team, board and chat. Removing one keeps its files.
- **Ask several.** Put one question to several models and see their answers side by side.
- **The Library** *(in progress).* A shared shelf of plain-text notes and skills, sorted into sections (frontend, backend, music, ideas, research), plus a guide every model reads when it starts. Agents can change any note, but only as a draft: you press Save, and the old version is kept.
- **Approvals.** Any risky command waits for you: allow once, deny, always allow, always deny.

## Requirements

- Windows (other systems likely work but aren't tested)
- [Node.js](https://nodejs.org) 26 or newer (uses the built-in SQLite)
- git
- A signed-in [Claude Code](https://claude.com/claude-code) (`claude` login)
- Optional: the Codex CLI, signed in (`codex login`)
- Optional: an [OpenRouter](https://openrouter.ai) key, for other models

## Getting started

```powershell
npm install
npm start
```

Then open `http://127.0.0.1:4317`.

### Adding OpenRouter (optional)

Type your key yourself; Trident never asks for it:

```powershell
setx OPENROUTER_API_KEY "your-key"
setx OPENROUTER_MODEL "qwen/qwen3-coder"
```

Restart Trident afterwards. The model setting is optional (`qwen/qwen3-coder` is the default).

## Where things live

| Folder | What's in it |
|---|---|
| `src/` | The engine: server, Lead, team, board, Library, workplaces |
| `public/` | The web page |
| `library/` | Your Library notes, drafts and old versions (not committed) |
| `workspace/` | The Main workplace's project folder (not committed) |
| `workplaces/` | Folders for other workplaces (not committed) |
| `data/` | Boards, chat history, settings (not committed) |
| `docs/` | Design notes |
| `spikes/` | Small test scripts |

## How a piece of work flows

```
You ──ask──▶ Lead ──plan──▶ you approve
                              │
                 ┌────────────┴────────────┐
             Worker A                  Worker B      (each in its own copy)
                 │                          │
          checked by another vendor   checked by another vendor
                 │                          │
                 └──────▶ Lead accepts and merges ──▶ checks "Done when" ──▶ tells you
```

## Status

Early and personal. Working: planning, workers, cross-checks, team talk, workplaces, Ask several, approvals. In progress: the Library screens and the Settings page (including how many agents work at once).

## Privacy

Everything runs locally. Prompts go only to the AI services you've signed in to (Anthropic, OpenAI and, if set up, OpenRouter). Trident always uses your own Claude sign-in and ignores any leftover settings that would send Claude traffic elsewhere.
