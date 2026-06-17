# Docker Garage

A beginner-friendly web app for visually configuring, generating, and live-testing custom Docker environments — all from a browser UI, all running inside Docker itself.

![Docker Garage](public/logo.svg)

---

## What it does

- **Blueprint Engine** — pick a base runtime (Node.js, Python, Go, PHP, Nginx, Ubuntu, Ruby, Java, Rust, Bun, .NET), add auxiliary services, tune options, choose a network topology, and instantly get a production-ready `Dockerfile` + `docker-compose.yml`
- **Download ZIP** — export the full stack as a ZIP (`Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`) with one click
- **Saved Presets** — save any config to `localStorage` and reload it later; overwrite-safe with a name-collision guard
- **Pre-flight check** — before launching, see which images are cached locally vs. need a pull, and which ports are already in use
- **Test Drive** — spin the generated stack up on your real Docker daemon and watch live logs stream into a built-in terminal (xterm.js)
- **Live Stack** — real-time container status panel that auto-refreshes while a session is running; each container shown as a card with a green (running) or red (exited) status border
- **Exec Shell** — open an interactive `sh` shell inside any running container directly in the browser terminal
- **Live Container Logs** — stream `docker logs -f` output into a dedicated read-only log pane (separate from the exec shell, so both can be open at the same time)
- **Kill All** — terminate every managed container at once without running `docker compose down`

---

## Architecture

Docker Garage uses **Docker-outside-of-Docker (DooD)**:

```
Browser
  │  HTTP / WebSocket (Socket.io)
  ▼
docker-garage-app container  (Node.js + Express + Socket.io)
  │  /var/run/docker.sock (mounted from host)
  ▼
Host Docker daemon
  │  spins up sibling containers (the user's generated stack)
  ▼
my-app + redis + postgres + …  (sibling containers on the host)
```

Generated files are written to `/tmp/docker-garage/` which is bind-mounted to the host so the Docker daemon can reach them directly.

### WebSocket events

| Event (client → server) | Purpose |
|---|---|
| `containers:refresh` | Fetch live container list |
| `exec:start` / `exec:stop` | Open / close interactive shell |
| `exec:input` / `exec:resize` | Forward keystrokes and terminal resize |
| `logs:start` / `logs:stop` | Start / stop streaming container logs |

| Event (server → client) | Purpose |
|---|---|
| `containers:list` | Updated container list |
| `exec:output` / `exec:ended` | Shell output / session ended |
| `logs:output` / `logs:ended` | Log stream data / stream ended |
| `testdrive:log` / `testdrive:done` / `testdrive:stopped` | Compose build log / completion |

---

## Quick start

### Requirements
- Docker Desktop (Windows/macOS) or Docker Engine (Linux)
- WSL2 on Windows

### Run

```bash
git clone https://github.com/idanmobile11-sketch/docker-garage.git
cd docker-garage
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000)

### Stop

```bash
docker compose down
```

---

## Project structure

```
docker-garage/
├── src/
│   ├── index.js                   # Express + Socket.io server + WebSocket handlers
│   ├── logger.js                  # File + console logger → /tmp/docker-garage/docker-garage.log
│   ├── engine/
│   │   ├── dockerEngine.js        # Dockerode wrapper — compose up/down, log streaming, cleanup
│   │   └── portChecker.js         # Port availability checks
│   ├── generator/
│   │   ├── dockerfileGenerator.js # Dockerfile string builder (11 base runtimes)
│   │   ├── composeGenerator.js    # docker-compose.yml string builder + network topology
│   │   └── serviceTemplates.js    # 12 auxiliary service definitions
│   └── routes/
│       ├── generate.js            # POST /api/generate
│       ├── testdrive.js           # POST /api/testdrive/start|stop|terminate
│       └── preflight.js           # POST /api/preflight (image + port checks)
├── public/
│   ├── index.html                 # Single-page frontend (Vanilla JS + xterm.js)
│   └── logo.svg                   # App logo
├── Dockerfile.dev                 # Dev image (node:20-alpine + docker-cli)
├── docker-compose.yml             # App container definition
├── docker-entrypoint.sh           # Runtime socket permission + tmp dir setup
└── Makefile                       # make up / make down / make clean
```

---

## Supported runtimes

| Base | Default image |
|------|--------------|
| Node.js | `node:20-alpine` |
| Python | `python:3.12-slim` |
| Go | `golang:1.22-alpine` |
| PHP | `php:8.3-fpm-alpine` |
| Nginx | `nginx:stable-alpine` |
| Ubuntu | `ubuntu:24.04` |
| Ruby | `ruby:3.3-alpine` |
| Java | `eclipse-temurin:21-jdk-alpine` |
| Rust | `rust:1.77-alpine` |
| Bun | `oven/bun:1-alpine` |
| .NET | `mcr.microsoft.com/dotnet/sdk:8.0` |

## Supported services

| Service | Image |
|---------|-------|
| Redis | `redis:7-alpine` |
| PostgreSQL | `postgres:16-alpine` |
| MySQL | `mysql:8` |
| MongoDB | `mongo:7` |
| Nginx | `nginx:alpine` |
| RabbitMQ | `rabbitmq:3-management-alpine` |
| Elasticsearch | `elasticsearch:8.13.0` |
| Kibana | `kibana:8.13.0` |
| Memcached | `memcached:alpine` |
| MinIO | `minio/minio:latest` |
| Mailpit | `axllent/mailpit:latest` |
| Adminer | `adminer:latest` |

---

## Network topologies

Configured via the **Network Topology** selector in the Blueprint Engine:

| Topology | Description |
|----------|-------------|
| **Flat** | Single shared network — all services reach each other (default) |
| **Segmented** | Two networks: `web` (nginx + app) and `internal` (app + all services). Nginx cannot reach the database directly. |
| **Full** | Three networks: `web`, `app`, and `db`. Database is reachable only from the app. |

> The `host` driver bypasses named networks entirely and shares the host network stack directly.

---

## Options

| Option | What it does |
|--------|-------------|
| **Non-root user** | Adds a least-privilege `appuser` to the generated Dockerfile |
| **Healthchecks** | Adds `HEALTHCHECK` to the Dockerfile and `depends_on: condition: service_healthy` to compose so the app waits for services to be ready |
| **Named volumes** | Adds a named volume for `/app/data` persistence across restarts |

---

## Container management

All containers generated by Docker Garage are tagged with the label `com.docker-garage.managed=true`. This enables:

- **Kill All** button — stops and removes all managed containers without needing `docker compose down`
- **Startup cleanup** — on server start, any orphaned containers from a previous session are automatically removed
- **Graceful shutdown** — in production mode, `SIGTERM`/`SIGINT` tears down all managed containers before exit

To inspect or clean up manually from outside the container:

```bash
# List all managed containers
docker ps --filter label=com.docker-garage.managed=true

# Remove them
docker rm -f $(docker ps -aq --filter label=com.docker-garage.managed=true)
```

---

## Debugging

Logs are written to `/tmp/docker-garage/docker-garage.log` on the host (via the bind mount). Auto-rotates at 5 MB.

```bash
# From the host (Linux/macOS/WSL)
tail -f /tmp/docker-garage/docker-garage.log

# Or from inside the app container
docker exec docker-garage-app cat /tmp/docker-garage/docker-garage.log
```

---

## License

MIT
