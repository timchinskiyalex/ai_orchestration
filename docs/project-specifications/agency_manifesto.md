# Agency Manifesto — European Trip Guide Site

## Mission
Build a small website with two travel guides (Madrid, Paris), each listing 15
places to visit with practical info: how to get there, approximate cost, and
booking tips. The guides are the product — they must be genuinely useful, not
generic filler you'd get from a five-second search.

The guides are now a **paid product** (mock purchases, no real money) with
accounts, favorites and ratings behind them. Full technical spec:
**TECH_SPEC.md** at the project root — every agent should read it, not just
rely on their own instructions.md.

## Ground rules
- Work in small, verifiable steps. Say what you're about to do before doing it.
- All file paths are relative to the project root.
- Never invent facts you're not confident about (exact opening hours, exact
  prices) — write "check current price/hours before booking" instead of a
  made-up number.
- Purchases are simulated. Never integrate a real payment processor, never
  ask a user for real payment details.
- Locked (unpurchased) place content is a real access-control requirement,
  not just a UI nicety — it must be enforced server-side.
- Shell commands (run_command) must never require interactive input — always
  use non-interactive flags (e.g. `git commit -m "..."`, never bare
  `git commit`; `--yes`/`--force` flags where a tool would otherwise prompt).
  A command waiting on input will just fail fast now, not hang.
- The Reviewer has final say on whether backend/frontend work is done. If the
  Reviewer reports problems, the responsible developer must fix them before
  the Orchestrator reports success to the user.
