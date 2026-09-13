# ADR 0001: LLM output is advisory

Status: Accepted

Flowless handles permission decisions, so malformed or semantically wrong model output must fail closed. The LLM extracts context and proposes a role-based path. Zod validates its shape; the deterministic engine checks all mandatory rules; the server resolves selectors to current users and owns every state transition.

The consequence is deliberate friction: unknown mandatory facts, stale previews, or ambiguous organization data stop submission. This is preferable to silently granting permission. Automatic approval remains outside v0.1.
