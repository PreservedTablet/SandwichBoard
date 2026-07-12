# prompts/

Versioned prompt templates for the AI layer. Prompts are code: they change
via pull requests, never ad hoc (docs/plan/02).

| File              | Phase | Status  | Purpose                                                                |
| ----------------- | ----- | ------- | ---------------------------------------------------------------------- |
| `analyze.md`      | 3     | **v1**  | Weekly report + `recommendations` rows, evidence-cited                 |
| `voice-reddit.md` | 4     | pending | Founder voice for disclosed Reddit replies (disclosure line mandatory) |
| `voice-brand.md`  | 4     | pending | Own-channel / UGC-style post voice                                     |

`/analyze` is invocable as a Claude Code command (`.claude/commands/analyze.md`);
the ritual and session profile are documented in docs/setup.md §4.5.

All prompts run in the operator's own Claude Code session on their own
subscription. This repository contains no Anthropic credentials and makes no
Anthropic API calls.
