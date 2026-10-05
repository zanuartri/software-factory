---
description: Review tickets in in_review and auto-merge the green ones into the base branch
argument-hint: "[T-1 T-2 ...] (default: all in_review)"
---

Load the `factory-manager` skill first. Apply its **review and merge policy**.

For each ticket in review (`$ARGUMENTS`, or `factory ticket list --status in_review`), in dependency order:

1. `factory ticket show T-x`. Read the Report, the Gate section, and the reviewer verdict.
2. `factory diff T-x`. Skim it for scope, Forbidden items, and anything the Report didn't mention.
3. Green → `factory merge T-x`, then handle the result:
   - `merged`: create issues for follow-ups and minor findings worth doing (`factory issue new`).
   - `conflict` / `verify_failed`: the worker was resumed automatically. Keep a background `factory wait` running
     and merge again once `✅ gate passed` comes back.
   - `reverted`: base verify failed after merge. The ticket is back to open with the failure in its Report. Tighten
     its Verify so the gate would have caught it.
4. Not green or unsure → a 5-line summary for the human (what, evidence, risk, recommendation) via AskUserQuestion:
   merge / send back with feedback (`factory tell T-x "..."`) / close.

End with: merged (sha), sent back, waiting, and follow-up issues created. Suggest `/factory:gc` once things are merged.
