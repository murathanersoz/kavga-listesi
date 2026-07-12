.PHONY: dev test build seed docker smoke

dev: ## server :3001 + vite :5173 (proxied)
	pnpm dev

test:
	pnpm --filter @kavga/server test

build:
	pnpm --filter @kavga/client build && pnpm --filter @kavga/server build

seed: ## demo room with 5 fake fighters + queued playlist
	pnpm --filter @kavga/server seed

smoke: ## e2e over real HTTP+WS (server must be running)
	node server/scripts/smoke.mjs

docker:
	docker compose up --build
