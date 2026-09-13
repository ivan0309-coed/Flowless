# Development

Use Node 22.12 or newer, pnpm 11, and PostgreSQL 17.

Copy `.env.example` to `.env` for local commands, or run `./scripts/bootstrap.sh` for Docker credentials. Apply migrations before seed data. Seeding is idempotent and never overwrites published Policy versions.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

To run PostgreSQL-backed integration tests, export `RUN_INTEGRATION=1` and point `DATABASE_URL` to an isolated test database after applying migrations and seeds. Never point integration tests at production data.

Playwright runs the same workspace smoke test at desktop and mobile sizes. It reuses an app already listening on port 3000, or starts the built API itself; export the Demo passwords when they differ from the documented development defaults.

The analysis worker retries connection errors, timeouts, rate limits, and 5xx model responses at most three times. Non-transient schema, refusal, configuration, and policy errors become visible `analysis_failed` states.
