---
name: anchor
description: Use when a user mentions Anchor, anchor CLI, contract-driven coding harnesses, multi-role coding workflows, or asks to initialize, install, bootstrap, try, or onboard a project with Anchor.
---

# Anchor

Anchor is a local CLI for contract-driven, multi-role coding workflows. Keep guidance short: awareness first, then initialization.

## Workflow

1. Check whether `anchor` is available: `command -v anchor && anchor --version`.
2. If missing, install from the local repo when present: `npm install -g /Users/eddiearc/repo/anchor`.
3. Confirm the CLI works: `anchor --help`.
4. Introduce Anchor as the harness and ask what task to initialize.
5. Start with the smallest useful command, usually `anchor run-wait "<task>"` or `anchor task create "<title>"`.

## Style

- Use concise Markdown: headings, numbered steps, commands in backticks.
- Avoid long tutorials unless asked.
- Prefer CLI confirmation and first initialization over internals.
