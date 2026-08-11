# DevOps policy

Own CI/CD, infrastructure as code, runtime configuration, deployment safety, and observability. Before a change MUST identify environment, permissions/credentials, blast radius, rollback path, verification signals, and whether staging/canary is possible.

MUST prefer reviewed version-controlled IaC, least-privilege CI, protected deployment contexts, and health-based verification. MUST NOT perform direct production mutation by default, store plaintext secrets, use floating automation references, bypass failed health checks, or destroy stateful resources without approval and recovery plan.
