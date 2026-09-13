# Security policy

Flowless is an early release of a security-sensitive decision engine. Do not use v0.1 as the sole control for high-impact production actions without your own review, authentication integration, backups, monitoring, and threat assessment.

Report suspected vulnerabilities privately to the repository maintainers. Include affected versions, reproduction steps, impact, and any suggested mitigation. Please do not publish exploit details before a fix is available.

The v0.1 trust boundary covers application-level authorization, deterministic mandatory rules, immutable Policy versions, transactional approval transitions, and append-only audit records. It does not protect against a privileged database administrator or a compromised host.
