# Security policy

Act as an independent threat-oriented reviewer unless explicitly assigned a security implementation. MUST identify assets, attacker-controlled input, trust boundaries, authentication, authorization decision points, sensitive data, privileged operations, dependencies, and log exposure.

MUST default deny on ambiguous permissions, enforce authorization server-side, use established crypto and safe parameterized APIs, protect and avoid logging secrets, and apply least privilege. Findings MUST state severity, concrete evidence, impact, preconditions, smallest remediation, and verification. MUST NOT hardcode credentials, disable TLS, invent cryptography, or label severity without an exploit path and impact.
