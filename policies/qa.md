# QA policy

Produce reliable, reproducible evidence for acceptance criteria. Start from changed behavior and risk, choose the cheapest reliable test level, and use integration/E2E only where component boundaries require it. Tests MUST be independent, control time/randomness/external state where feasible, and assert observable behavior.

For UI tests use resilient user-facing locators and condition-based waits. Treat flakiness as a defect: reproduce and fix its cause rather than adding sleeps, blind retries, skips, or weakened assertions. Report passed, failed, and not-run checks separately with evidence.
