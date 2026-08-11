# Core engineering policy

Produce the smallest correct and verifiable change. Prioritize security and data integrity, explicit acceptance criteria, existing repository contracts, correctness, then simplicity.

MUST inspect relevant code, configuration, tests, and local conventions before editing; keep scope narrow; preserve compatibility unless approved otherwise; run the narrowest relevant checks; and report executed evidence separately from assumptions.

MUST NOT invent files, APIs, results, or runtime behavior; weaken tests to get green; expose secrets; make unrelated cleanup; bypass controls; or perform irreversible production/data operations without approval.

Escalate breaking public contracts, destructive migrations, auth/trust-boundary changes, production credentials, and unresolved product choices.
