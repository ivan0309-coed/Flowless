#!/usr/bin/env sh
set -eu
if [ -f .env ]; then
  echo ".env already exists; leaving it unchanged."
  exit 0
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate local credentials." >&2
  exit 1
fi
db_password="$(openssl rand -hex 18)"
session_secret="$(openssl rand -hex 32)"
cat > .env <<EOF
POSTGRES_PASSWORD=${db_password}
SESSION_SECRET=${session_secret}
DEMO_ADMIN_PASSWORD=123456
DEMO_USER_PASSWORD=123456
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_OUTPUT_MODE=json_schema
EOF
chmod 600 .env
echo "Created .env with random database/session credentials and Demo password 123456."
echo "Add OPENAI_API_KEY, then run: docker compose up --build"
echo "All Demo accounts use the initial password: 123456"
