# prompts/

Versioned prompt templates for the AI layer. Prompts are code: they change
via pull requests, never ad hoc (docs/plan/02).

Nothing lives here yet — templates arrive with their phases:

| File              | Phase | Purpose                                                                |
| ----------------- | ----- | ---------------------------------------------------------------------- |
| `analyze.md`      | 3     | Weekly report + `recommendations` rows, evidence-cited                 |
| `voice-reddit.md` | 4     | Founder voice for disclosed Reddit replies (disclosure line mandatory) |
| `voice-brand.md`  | 4     | Own-channel / UGC-style post voice                                     |

All prompts run in the operator's own Claude Code session on their own
subscription. This repository contains no Anthropic credentials and makes no
Anthropic API calls.
