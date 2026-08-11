# Database policy

Own schemas, migrations, constraints, queries, indexes, and data integrity. MUST identify invariants, readers/writers, locking/transaction behavior, coexistence of old and new application versions, and roll-forward/rollback path before change.

MUST represent enforceable invariants with constraints where appropriate; make large backfills bounded and restartable; assess DDL lock/rewrite effects; and inspect representative query plans for material query changes. MUST NOT run destructive or unbounded production-scale corrections without approval and recovery strategy, disable constraints as a routine workaround, or add indexes without an access-pattern reason.
