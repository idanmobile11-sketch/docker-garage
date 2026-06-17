<div align="center">

```
██████╗  ██████╗  ██████╗██╗  ██╗███████╗██████╗
██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝██╔════╝██╔══██╗
██║  ██║██║   ██║██║     █████╔╝ █████╗  ██████╔╝
██║  ██║██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
██████╔╝╚██████╔╝╚██████╗██║  ██╗███████╗██║  ██║
╚═════╝  ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
                              ██████╗  █████╗ ██████╗  █████╗  ██████╗ ███████╗
                             ██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔════╝
                             ██║  ███╗███████║██████╔╝███████║██║  ███╗█████╗
                             ██║   ██║██╔══██║██╔══██╗██╔══██║██║   ██║██╔══╝
                             ╚██████╔╝██║  ██║██║  ██║██║  ██║╚██████╔╝███████╗
                              ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

**Build Docker environments visually. Preview them instantly. Run them live — all from your browser.**

[![Node.js](https://img.shields.io/badge/Node.js-20-brightgreen?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-DooD-blue?logo=docker)](https://docker.com)
[![Socket.io](https://img.shields.io/badge/Socket.io-4-black?logo=socket.io)](https://socket.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
</div>

---
App Preview: https://docker-garage.vercel.app/

## What is Docker Garage?

Docker Garage is a **browser-based Docker environment builder** aimed at developers who want to understand and use Docker without wrestling with raw YAML syntax.

You pick a runtime (Node, Python, Go, etc.), add services (Redis, Postgres, etc.), choose a network topology, toggle options — and Docker Garage writes production-quality `Dockerfile` + `docker-compose.yml` files for you. Then you can hit **Test Drive** and watch it actually spin up on your real Docker daemon, with live logs streaming straight into a browser terminal.

It runs inside Docker itself, via **Docker-outside-of-Docker (DooD)** — one `docker compose up` and the whole tool is running.

---

## Features

### Blueprint Engine
- **11 base runtimes** — Node.js, Python, Go, PHP, Nginx, Ubuntu, Ruby, Java, Rust, Bun, .NET
- **12 auxiliary services** — Redis, PostgreSQL, MySQL, MongoDB, RabbitMQ, Elasticsearch, Kibana, MinIO, Memcached, Mailpit, Adminer, Nginx
- **3 network topologies** — flat, segmented (web/backend), full three-tier isolation
- **Option flags** — non-root user, healthchecks, named volumes
- **Custom overrides** — base image version, app port, startup command
- **Conflict detection** — warns if you add two database UIs or incompatible combos

### Generated Output
- Production-ready `Dockerfile` with beginner-friendly inline comments
- `docker-compose.yml` with named volumes, healthcheck dependencies, environment variable stubs
- `.env.example` with every variable pre-filled with safe defaults
- `README.md` for the generated project with run instructions
- **Download ZIP** — exports the entire stack as a single archive

### Pre-flight Check
Before launching, Docker Garage tells you:
- Which images are already cached locally vs. need a pull
- Which ports are already in use on your machine
- Which conflicts to fix before the run succeeds

### Test Drive
- Spins up the generated stack on your real Docker daemon
- Streams `docker compose up --build` output live into a browser terminal (xterm.js)
- **No source code needed** — uses stub images to prove the network wiring works

### Live Stack Panel
Real-time container status while a session is running:
- Each container shown as a card: image, ports, running / exited status
- **Exec Shell** — open an interactive `sh` shell inside any container, directly in the browser
- **Live Logs** — stream `docker logs -f` into a dedicated read-only log pane
- **Kill All** — terminate every managed container at once

### Saved Presets
- Save any Blueprint config to `localStorage` with a name
- Reload it in one click — name-collision guard prevents accidental overwrites
- Useful for teams sharing common stack configurations

### Lifecycle Management
- All generated containers are tagged `com.docker-garage.managed=true`
- Orphaned containers from crashed sessions are cleaned up on next startup
- Graceful shutdown (`SIGTERM`/`SIGINT`) tears down all managed containers before exit

---

## Quick Start

### Requirements
- Docker Desktop (Windows / macOS) or Docker Engine (Linux)
- WSL2 on Windows

### Start

```bash
git clone https://github.com/idanmobile11-sketch/docker-garage.git
cd docker-garage
docker compose up -d --build
```

Open **http://localhost:3000**

### Stop

```bash
docker compose down
```

### Make targets

```bash
make up        # Start (cleans stale managed containers first)
make down      # Stop (cleans managed containers after)
make restart   # Bounce the app container
make logs      # Tail live app logs
make shell     # Open a shell inside the app container
make clean     # Remove all managed containers from a previous session
```

---

## How It Works

### Docker-outside-of-Docker (DooD)

Docker Garage runs inside a container — and controls Docker from inside that container by mounting the host's Docker socket.

```
Browser (localhost:3000)
  │
  │  HTTP / WebSocket (Socket.io)
  ▼
┌─────────────────────────────────────────┐
│  docker-garage-app                      │
│  Node.js + Express + Socket.io          │
│  /var/run/docker.sock  ◄── mounted      │
└───────────────┬─────────────────────────┘
                │  socket → Host Docker daemon
                ▼
┌────────────────────────────────────────┐
│  Host Docker daemon                    │
│                                        │
│  spawns sibling containers:            │
│    my-app  redis  postgres  nginx  …   │
└────────────────────────────────────────┘
```

Generated files are written to `/tmp/docker-garage/<sessionId>/` which is bind-mounted from the host, so the Docker daemon can find them when building.

### Test Drive Internals

When you click **Test Drive**:

1. The backend generates `Dockerfile` + `docker-compose.yml` and writes them to `/tmp/docker-garage/<sessionId>/` on the host.
2. It spawns a temporary `docker:cli` runner container that has the host socket and host `/tmp` path available.
3. The runner executes `docker compose up -d --build` inside the session directory.
4. Output is piped back through `docker.modem.demuxStream()` and emitted to Socket.io, which the browser xterm.js terminal renders in real time.
5. Every generated container gets labelled `com.docker-garage.managed=true` for cleanup tracking.

### Permission Handling (cross-platform)

The `docker-entrypoint.sh` script runs at container start and fixes socket permissions so the non-root `appuser` can reach the Docker daemon:

- Detects the GID of `/var/run/docker.sock` at runtime (differs between Linux, macOS, and Windows/WSL2)
- Creates a matching group inside the container
- Adds `appuser` to that group
- Falls back gracefully if the socket is owned by root

---

## Architecture

### Directory layout

```
docker-garage/
├── src/
│   ├── index.js                    # Express server + Socket.io wiring + WebSocket handlers
│   ├── logger.js                   # Structured logger — file + console, 5 MB rotation
│   │
│   ├── engine/
│   │   ├── dockerEngine.js         # Core Docker layer: compose up/down, log streaming, cleanup
│   │   └── portChecker.js          # TCP port availability probe
│   │
│   ├── generator/
│   │   ├── dockerfileGenerator.js  # Dockerfile string builder (11 base runtimes)
│   │   ├── composeGenerator.js     # docker-compose.yml builder + network topology logic
│   │   └── serviceTemplates.js     # 12 auxiliary service definitions (images, ports, volumes, env)
│   │
│   └── routes/
│       ├── generate.js             # POST /api/generate — validate config → call generators
│       ├── testdrive.js            # POST /api/testdrive/start|stop|terminate + file preview
│       └── preflight.js            # POST /api/preflight — image cache + port availability checks
│
├── public/
│   ├── index.html                  # Single-page frontend: wizard, terminal, stack panel
│   └── logo.svg                    # App logo
│
├── Dockerfile.dev                  # node:20-alpine + docker-cli + compose plugin
├── docker-compose.yml              # App container + socket mount + tmp bind mount
├── docker-entrypoint.sh            # Runtime socket GID fix + tmp dir setup
├── Makefile                        # make up / down / logs / shell / clean
└── package.json                    # Express, Socket.io, dockerode, nodemon
```

### WebSocket event reference

**Client → Server**

| Event | Payload | Purpose |
|---|---|---|
| `containers:refresh` | — | Re-fetch live container list |
| `exec:start` | `{ containerId, cols, rows }` | Open interactive shell in a container |
| `exec:input` | `{ containerId, data }` | Forward keystrokes to the shell |
| `exec:resize` | `{ containerId, cols, rows }` | Resize the PTY |
| `exec:stop` | `{ containerId }` | Close the shell session |
| `logs:start` | `{ containerId }` | Begin streaming `docker logs -f` |
| `logs:stop` | `{ containerId }` | Stop the log stream |

**Server → Client**

| Event | Payload | Purpose |
|---|---|---|
| `containers:list` | `[container, …]` | Updated container list |
| `exec:output` | `{ containerId, data }` | Shell output chunk |
| `exec:ended` | `{ containerId }` | Shell session closed |
| `logs:output` | `{ containerId, data }` | Log data chunk |
| `logs:ended` | `{ containerId }` | Log stream ended |
| `testdrive:log` | `{ data }` | Compose build log line |
| `testdrive:done` | `{ sessionId }` | Compose run finished successfully |
| `testdrive:stopped` | — | Stack was stopped |

### REST API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Docker daemon info + ping |
| `GET` | `/api/containers` | List all running containers |
| `POST` | `/api/generate` | Generate Dockerfile + compose from config |
| `POST` | `/api/testdrive/start` | Write files + trigger `compose up` |
| `POST` | `/api/testdrive/stop` | Run `compose down` for a session |
| `POST` | `/api/testdrive/terminate` | Kill all managed containers |
| `GET` | `/api/testdrive/files/:sessionId` | Preview generated file contents |
| `POST` | `/api/preflight` | Image cache + port availability |

---

## Supported Runtimes

| Runtime | Default image | Default port |
|---------|--------------|-------------|
| Node.js | `node:20-alpine` | 3000 |
| Python | `python:3.12-slim` | 8000 |
| Go | `golang:1.22-alpine` | 8080 |
| PHP | `php:8.3-fpm-alpine` | 9000 |
| Nginx | `nginx:stable-alpine` | 80 |
| Ubuntu | `ubuntu:24.04` | 8080 |
| Ruby | `ruby:3.3-alpine` | 3000 |
| Java | `eclipse-temurin:21-jdk-alpine` | 8080 |
| Rust | `rust:1.77-alpine` | 8080 |
| Bun | `oven/bun:1-alpine` | 3000 |
| .NET | `mcr.microsoft.com/dotnet/sdk:8.0` | 8080 |

Custom base image tags and custom ports are supported via the UI.

---

## Supported Services

| Service | Image | Default port |
|---------|-------|-------------|
| Redis | `redis:7-alpine` | 6379 |
| PostgreSQL | `postgres:16-alpine` | 5432 |
| MySQL | `mysql:8` | 3306 |
| MongoDB | `mongo:7` | 27017 |
| Nginx | `nginx:alpine` | 80 |
| RabbitMQ | `rabbitmq:3-management-alpine` | 5672 / 15672 |
| Elasticsearch | `elasticsearch:8.13.0` | 9200 |
| Kibana | `kibana:8.13.0` | 5601 |
| Memcached | `memcached:alpine` | 11211 |
| MinIO | `minio/minio:latest` | 9000 / 9001 |
| Mailpit | `axllent/mailpit:latest` | 1025 / 8025 |
| Adminer | `adminer:latest` | 8080 |

All services include pre-configured healthchecks, named volumes, and environment variable stubs.

---

## Network Topologies

### Flat (default)
All services on a single shared network. The simplest setup — every container can reach every other.

```
[app] ── [redis] ── [postgres] ── [nginx]
              └──────── app-net ────────┘
```

### Segmented
Two networks: `web` (nginx + app) and `internal` (app + all backend services).
Nginx cannot reach the database directly — the app is the only bridge.

```
         web-net               internal-net
  [nginx] ── [app] ── [redis] ── [postgres]
```

### Full
Three networks: `web`, `app`, and `db`.
The database is reachable only from the app tier — maximum isolation.

```
  web-net     app-net        db-net
  [nginx] ── [app] ── [redis] ── [postgres]
```

> The **host** network driver bypasses all of the above and shares the host network stack directly.

---

## Options

| Option | Generated output |
|--------|-----------------|
| **Non-root user** | Adds `RUN addgroup` + `adduser` + `USER appuser` to the Dockerfile |
| **Healthchecks** | Adds `HEALTHCHECK` to the Dockerfile and `depends_on: condition: service_healthy` in compose |
| **Named volumes** | Adds a named volume for `/app/data` with a top-level `volumes:` block in compose |

---

## Container Lifecycle

All containers spawned by Docker Garage are tagged with:

```yaml
labels:
  com.docker-garage.managed: "true"
```

This enables three things:

1. **Kill All** — one button stops and removes every managed container without needing `docker compose down`
2. **Startup cleanup** — orphaned containers from a previous crashed session are removed when the app starts
3. **Graceful shutdown** — `SIGTERM`/`SIGINT` tears down all managed containers before the Node process exits

To inspect or clean up from outside the container:

```bash
# List
docker ps --filter label=com.docker-garage.managed=true

# Remove
docker rm -f $(docker ps -aq --filter label=com.docker-garage.managed=true)
```

---

## Debugging

App logs are written to `/tmp/docker-garage/docker-garage.log` on the host (via the bind mount). They auto-rotate at 5 MB.

```bash
# From the host (Linux / macOS / WSL)
tail -f /tmp/docker-garage/docker-garage.log

# Or from inside the app container
docker exec docker-garage-app cat /tmp/docker-garage/docker-garage.log
```

For Socket.io traffic, open the browser DevTools → Network → WS and watch the `/socket.io/` connection.

---

## Development

The dev container mounts `src/` and `public/` as live volumes — no rebuild needed when editing code.

```bash
make shell          # Shell into the running app container
# or
docker exec -it docker-garage-app sh
```

`nodemon` watches `src/` and restarts the server automatically on save.

Package dependencies:

| Package | Version | Role |
|---------|---------|------|
| `express` | ^4.18 | HTTP server + routing |
| `socket.io` | ^4.7 | Real-time WebSocket layer |
| `dockerode` | ^4.0 | Docker daemon client (HTTP over socket) |
| `nodemon` | ^3.0 | Dev auto-restart |

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 — Scaffolding | ✅ Done | Project structure, Dockerfile.dev, DooD setup, Socket.io wiring |
| 2 — Generator | ✅ Done | Blueprint Engine, 11 runtimes, 12 services, 3 topologies, ZIP export |
| 3 — Test Drive | ✅ Done | Compose runner, live log streaming, exec shell, live stack panel |
| 4 — Showroom UI | ⬜ Next | Full xterm.js terminal overhaul, polished frontend, community presets |

---

## License

MIT — use it, fork it, learn from it.
