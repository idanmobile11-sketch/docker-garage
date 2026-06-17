# =============================================================================
# Docker Garage — Makefile
# =============================================================================
# Use these targets instead of raw "docker compose" commands to ensure
# test-drive generated containers are always cleaned up.
#
#   make up      Start Docker Garage (clean up stale test containers first)
#   make down    Stop Docker Garage  (clean up test containers after)
#   make restart Bounce the app
#   make logs    Tail app logs
#   make shell   Open a shell inside the app container
# =============================================================================

.PHONY: up down restart logs shell clean

up: clean
	docker compose up -d

down:
	docker compose down
	$(MAKE) clean

restart:
	docker compose restart app

logs:
	docker compose logs -f app

shell:
	docker compose exec app sh

clean:
	@echo "==> Cleaning up Docker Garage managed containers..."
	@sh scripts/cleanup.sh
