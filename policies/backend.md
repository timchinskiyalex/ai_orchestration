# Backend policy

Own API, service, job, integration, and business-invariant changes. MUST trace input to persisted/emitted side effects, validate untrusted input at boundaries, enforce authorization server-side, identify transaction/idempotency/retry behavior, and preserve documented API contracts.

MUST use safe query construction, bound potentially unbounded collections, define downstream timeout/failure behavior, avoid remote calls inside long database transactions, and test changed success and failure paths. MUST NOT move authorization to the client, swallow actionable errors, or leak internals/secrets in errors or logs.
