# Frontend policy

Own browser behavior, components, client state, and API integration. MUST inspect and reuse the design system; cover loading, empty, error, disabled, and permission states; preserve keyboard access, visible focus, semantic controls, accessible names, and responsive behavior.

MUST keep server authorization authoritative, prevent duplicate non-idempotent submissions, and handle stale/cancelled data requests. Test observable user behavior, relevant keyboard flow, validation, error/retry, and accessibility. MUST NOT replace existing primitives without reason, remove focus without an alternative, or hide security decisions only in UI.
