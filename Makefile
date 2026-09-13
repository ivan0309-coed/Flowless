.PHONY: setup up down logs test build
setup:
	./scripts/bootstrap.sh
up:
	docker compose up --build
down:
	docker compose down
logs:
	docker compose logs -f app
test:
	pnpm test
build:
	pnpm build
