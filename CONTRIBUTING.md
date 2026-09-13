# Contributing

Thank you for helping build Flowless. Open an issue before large changes so the design stays focused on approval and decision infrastructure.

1. Use Node 22.12+, pnpm 11, and PostgreSQL 17.
2. Create a focused branch and keep public schemas backward compatible when possible.
3. Add meaningful tests for Policy, Planner validation, role resolution, or runtime state changes.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`.
5. Explain the behavior change and validation evidence in the pull request.

Security fixes should follow [SECURITY.md](SECURITY.md) rather than a public issue.
