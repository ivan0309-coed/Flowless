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
admin_password="$(openssl rand -base64 18 | tr -d '/+=')"
user_password="$(openssl rand -base64 18 | tr -d '/+=')"
cat > .env <<EOF
POSTGRES_PASSWORD=${db_password}
SESSION_SECRET=${session_secret}
DEMO_ADMIN_PASSWORD=${admin_password}
DEMO_USER_PASSWORD=${user_password}
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_OUTPUT_MODE=json_schema
EOF
chmod 600 .env
echo "Created .env with random database, session, and demo passwords."
echo "Add OPENAI_API_KEY, then run: docker compose up --build"
echo "Demo user password: ${user_password}"
echo "Demo admin password: ${admin_password}"
