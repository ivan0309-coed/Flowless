# Flowless

**Open-source AI-native approval and decision engine.**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/ivan0309-coed/Flowless?quickstart=1)

Flowless answers a narrow but important question for business systems and AI agents: **may this action continue, who must approve it, and why?** It turns a natural-language or structured business event into a policy-backed, deterministically validated, human-approved decision with a complete audit trail.

[中文文档](README.zh-CN.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [Security](SECURITY.md)

The repository includes a GitHub Codespaces configuration for running the complete demo in GitHub. Use the badge above or see [GitHub Demo](docs/github-demo.md).

## What works in v0.1

- Natural-language and structured business-event input
- OpenAI-compatible understanding and approval planning
- Bounded policy retrieval plus full deterministic validation of mandatory rules
- Versioned policies, organization roles, manager relationships, and scoped role resolution
- Sequential approve, reject, and request-information actions
- Version-bound `pending | allow | deny` decisions and append-only audit history
- Three real demo scenarios driven by the same engine: procurement, production change, and production database access

The LLM never grants permission. `allow` is produced only after confirmed facts pass deterministic validation and every required human approval is completed by the current authorized assignee.

## Quick start with Docker

Requirement: Docker Compose. Add an OpenAI-compatible API key to run AI analysis.

```bash
./scripts/bootstrap.sh
```

Add `OPENAI_API_KEY` to the generated `.env`, then start Flowless:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Every Demo account initially uses `123456`. Use `requester@flowless.local` to create a request, then sign in as each assignee shown in the generated path.

Try these events:

1. `需要购买一台8万元GPU服务器，用于AI项目测试。`
2. `今晚22:00升级核心生产服务，预计影响登录功能10分钟，属于高风险变更。`
3. `给市场部员工开通生产数据库只读权限30天，用于分析客户活动效果。`

Without an API key, Flowless still starts and exposes policy and organization data, but analysis enters an explicit failure state. It does not substitute hard-coded AI output.

## Local development

```bash
pnpm install
docker compose up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The web app runs at `http://localhost:5173` and proxies `/api` to the API at port 3000. See [Development](docs/development.md) for test and environment details.

## Integration

The versioned API lives under `/api/v1`. Create a scoped API token as an administrator, submit an event, poll its status, and read `/requests/{id}/decision`. The decision includes the request revision and confirmed-context hash so a caller cannot reuse approval for changed facts. See [API examples](docs/api.md) and `/api/v1/openapi.json`.

## Project structure

```text
apps/web             React working interface
apps/api             Fastify API, worker, migrations, and seed data
packages/contracts   Shared runtime schemas and public types
packages/core        Provider-independent retrieval and deterministic policy engine
docs                 Architecture, operation, and API guidance
```

## Current boundaries

v0.1 supports one organization and sequential human approval. Parallel approval, SSO, multi-tenancy, automatic permission, and execution of the originating business action are intentionally outside this release.

Licensed under the [Apache License 2.0](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
