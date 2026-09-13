# GitHub Codespaces Demo

Flowless needs a server and PostgreSQL, so its GitHub-hosted demo uses Codespaces rather than GitHub Pages. The Codespace starts the real Fastify API, PostgreSQL database, durable worker, migrations, seed data, and React application.

1. Open the repository in GitHub Codespaces and choose **Create codespace on main**.
2. Wait for `postCreateCommand` to install dependencies, migrate and seed PostgreSQL, build the application, and verify that the API is healthy.
3. Open the forwarded **Flowless Demo** port 3000. All Demo accounts use the initial password `123456`.
4. To enable real AI analysis, create a GitHub Codespaces repository secret named `OPENAI_API_KEY`. Optional secrets `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_OUTPUT_MODE` select another OpenAI-compatible provider.

Without a model key, the application still shows the real organization and Policy data and reports AI as unconfigured. It never substitutes a fixed plan or approval result.

The Codespace starts Flowless through `scripts/start-codespace.sh`. If startup fails, inspect `/tmp/flowless.log` in the Codespace terminal.
