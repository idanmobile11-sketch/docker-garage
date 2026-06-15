# Docker Garage

A beginner-friendly web app for visually configuring, generating, and live-testing custom Docker environments — all from a browser UI, all running inside Docker itself.

![Docker Garage](public/logo.svg)

---

## What it does

- **Generate** — pick a base runtime (Node.js, Python, Go, PHP, Nginx, Ubuntu), add auxiliary services (Redis, Postgres, MySQL, MongoDB, RabbitMQ, MinIO, and more), tune options, and instantly get a production-ready `Dockerfile` + `docker-compose.yml`
- **Test Drive** — click one button to spin the generated stack up on your real Docker daemon and watch live logs stream into the browser terminal
- **Pre-flight check** — before launching, see which images are cached locally vs. need a pull, and which ports are already in use

---

## Architecture

Docker Garage uses **Docker-outside-of-Docker (DooD)**:

```
Browser
  │  HTTP / WebSocket
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

---

## Quick start

### Requirements
- Docker Desktop (Windows/macOS) or Docker Engine (Linux)
- WSL2 on Windows

### Run

```bash
git clone https://github.com/your-username/docker-garage.git
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
│   ├── index.js                   # Express + Socket.io server
│   ├── logger.js                  # File + console logger → /tmp/docker-garage/docker-garage.log
│   ├── engine/
│   │   ├── dockerEngine.js        # Dockerode wrapper — compose up/down, log streaming
│   │   └── portChecker.js         # Port availability checks
│   ├── generator/
│   │   ├── dockerfileGenerator.js # Dockerfile string builder (6 base runtimes)
│   │   ├── composeGenerator.js    # docker-compose.yml string builder
│   │   └── serviceTemplates.js    # 12 auxiliary service definitions
│   └── routes/
│       ├── generate.js            # POST /api/generate
│       ├── testdrive.js           # POST /api/testdrive/start|stop
│       └── preflight.js           # POST /api/preflight (image + port checks)
├── public/
│   ├── index.html                 # Single-page frontend (Vanilla JS)
│   └── logo.svg                   # App logo
├── Dockerfile.dev                 # Dev image (node:20-alpine + docker-cli)
├── docker-compose.yml             # App container definition
└── docker-entrypoint.sh           # Runtime socket permission + tmp dir setup
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

## Options

- **Non-root user** — adds a least-privilege `appuser` to the generated Dockerfile
- **Healthchecks** — adds `HEALTHCHECK` to the Dockerfile and `depends_on: condition: service_healthy` to compose
- **Named volumes** — adds a named volume for `/app/data` persistence

---

## Debugging

Logs are written to `/tmp/docker-garage/docker-garage.log` on the host (via the bind mount). Read them any time:

```bash
# From the host (Linux/macOS/WSL)
cat /tmp/docker-garage/docker-garage.log

# Or from inside the container
docker exec docker-garage-app cat /tmp/docker-garage/docker-garage.log
```

---

## Roadmap

- [x] Phase 1 — Scaffolding & containerization (DooD, entrypoint, hot-reload)
- [x] Phase 2 — Generator (Dockerfile + docker-compose.yml, 6 runtimes, 12 services)
- [x] Phase 3 — Docker Engine + WebSockets (live log streaming, Test Drive, pre-flight)
- [ ] Phase 4 — Showroom UI + xterm.js terminal

---

## License

MIT
