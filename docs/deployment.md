# Deployment

`docker compose up --build` starts PostgreSQL 17 and one application container. The database health check gates the application; the application runs versioned migrations, applies idempotent demo seed data, and only then starts the API and analysis worker.

For anything beyond local evaluation:

- terminate TLS at a trusted reverse proxy and set `COOKIE_SECURE=true`;
- replace demo accounts and rotate generated credentials;
- restrict database network access and back up the named volume;
- set an explicit OpenAI-compatible base URL and model verified to support the configured output mode;
- ship structured logs to protected storage and monitor `/api/v1/health`;
- run migrations as a controlled release step before scaling to more than one application replica.

Flowless v0.1 does not claim tamper resistance against a database administrator. External immutable storage or cryptographic audit anchoring is a later enterprise capability.
