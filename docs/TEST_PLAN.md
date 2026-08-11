# Deterministic test plan

`npm test` covers autonomous Bootstrap → Planner → DAG; bounded parallel workers; WorkerArtifact finalization; Security/QA remediation and retry limits; exact-SHA candidate push, PR, CI, merge, and restart idempotency; CI/protection blockers; greenfield Next/ASP.NET roots; overlay refresh; scoped Node/.NET verification; and launcher dirty-tree behavior.

Run `npm run test:app-server-schema` separately to preflight the installed App Server schema. Do not run quota-spending E2E as part of this plan.
