---
name: refine-permissions
description: >-
  Analyze this machine's recent agent session history and propose safer
  OpenCode shell allowlist rules (patterns for read-only commands that were
  actually run). Use when the user asks to refine, update, or extend the
  permission allowlist, or complains about repeated permission prompts for
  safe commands like git fetch, ls, sort, or cut.
---

# refine-permissions

## Steps

1. Call the `refine_permissions` tool with `mode: "analyze"`.
2. If `proposals` is empty, report why — everything observed is already
   covered, or the window had no history — and stop.
3. Print a batch summary: the window analyzed, and each proposed pattern with
   its run count and example commands.
4. Ask exactly one question, single-select, options:
   `Accept all` — `Fine-tune` — `Reject`.
   - **Accept all**: call `mode: "apply"` with `rules: [every proposed pattern]`.
   - **Fine-tune**: ask the user what to change (free-form follow-up). Adjust
     the batch per their instructions; patterns failing the plugin's safety
     gate come back as `skippedForSafety` — report those and apply the rest
     with `mode: "apply"`.
   - **Reject**: change nothing. Note that the analysis marker advanced, so
     this batch will not reappear until new activity lands in the window.
5. After apply, report `added`, `alreadyPresent`, `skippedForSafety`, and the
   backup file path. Mention that new rules take effect for subsequent tool
   calls (OpenCode reloads config on change).
