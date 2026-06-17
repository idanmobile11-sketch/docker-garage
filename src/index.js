// =============================================================================
// Docker Garage - Backend Entry Point (src/index.js)
// =============================================================================
// Wires together:
//   1. Express        : static files + REST API routes
//   2. Socket.io      : real-time WebSocket (used for live log streaming)
//   3. Dockerode      : Docker daemon connection via mounted socket
//   4. dockerEngine   : Phase 3 — compose execution + log streaming
// =============================================================================

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const log     = require('./logger');

// --- Route modules ---
const generateRoute             = require('./routes/generate');
const { router: testdriveRoute,
        setIo: setTestdriveIo } = require('./routes/testdrive');
const preflightRoute            = require('./routes/preflight');

// --- Docker engine (Phase 3) ---
const { docker, getDockerInfo, listContainers, terminateAllManaged } = require('./engine/dockerEngine');

// =============================================================================
// 1. Express + HTTP server
// =============================================================================
const app    = express();
const server = http.createServer(app);

// =============================================================================
// 2. Socket.io
// =============================================================================
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || 'http://localhost:3000', methods: ['GET', 'POST'] },
});

// Inject io into the testdrive route so it can look up sockets by ID
setTestdriveIo(io);

// =============================================================================
// 3. Express middleware
// =============================================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// =============================================================================
// 4. REST API routes
// =============================================================================

// Phase 2 — POST /api/generate
app.use('/api', generateRoute);

// Phase 3 — POST /api/testdrive/start  |  POST /api/testdrive/stop
app.use('/api/testdrive', testdriveRoute);

// Pre-flight checks — POST /api/preflight
app.use('/api/preflight', preflightRoute);

// GET /api/health — liveness + docker info
app.get('/api/health', async (req, res) => {
  try {
    const info = await getDockerInfo();
    res.json({
      status: 'ok',
      docker: {
        version:           info.ServerVersion,
        totalContainers:   info.Containers,
        runningContainers: info.ContainersRunning,
        os:                info.OperatingSystem,
        architecture:      info.Architecture,
      },
    });
  } catch (err) {
    console.error('[API] Docker health check failed:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /api/containers — live list of running containers on the host
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await listContainers();
    res.json({ containers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// 5. WebSocket events
// =============================================================================

// Active exec and log sessions keyed by socket ID
const execSessions = new Map(); // socketId → { stream, exec }
const logSessions  = new Map(); // socketId → stream

function cleanupExecSession(socketId) {
  const session = execSessions.get(socketId);
  if (session?.stream) { try { session.stream.destroy(); } catch {} }
  execSessions.delete(socketId);
}

function cleanupLogSession(socketId) {
  const stream = logSessions.get(socketId);
  if (stream) { try { stream.destroy(); } catch {} }
  logSessions.delete(socketId);
}

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected  : ${socket.id}`);

  // ---- Container list ----
  socket.on('containers:refresh', async () => {
    try {
      const containers = await listContainers();
      socket.emit('containers:list', { containers });
    } catch (err) {
      socket.emit('containers:list', { containers: [], error: err.message });
    }
  });

  // ---- Exec terminal ----
  // Opens an interactive shell (sh) inside the target container.
  // Uses Tty:true so the stream is raw bytes — no demux needed.
  socket.on('exec:start', async ({ containerId }) => {
    cleanupExecSession(socket.id);

    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      if (info.Config?.Labels?.['com.docker-garage.managed'] !== 'true') {
        socket.emit('exec:ended', { error: 'Access denied: not a Docker Garage managed container.' });
        return;
      }
      const exec = await container.exec({
        Cmd:          ['sh'],
        AttachStdin:  true,
        AttachStdout: true,
        AttachStderr: true,
        Tty:          true,
      });

      const stream = await exec.start({ hijack: true, stdin: true });
      execSessions.set(socket.id, { stream, exec });

      stream.on('data', (chunk) => {
        socket.emit('exec:output', { data: chunk.toString('utf8') });
      });

      stream.on('end', () => {
        execSessions.delete(socket.id);
        socket.emit('exec:ended', {});
      });

      stream.on('error', (err) => {
        execSessions.delete(socket.id);
        socket.emit('exec:ended', { error: err.message });
      });

    } catch (err) {
      log.error('[Exec] exec:start failed', err);
      socket.emit('exec:ended', { error: err.message });
    }
  });

  socket.on('exec:input', ({ data }) => {
    const session = execSessions.get(socket.id);
    if (session?.stream) { try { session.stream.write(data); } catch {} }
  });

  socket.on('exec:resize', ({ cols, rows }) => {
    const session = execSessions.get(socket.id);
    if (session?.exec) {
      session.exec.resize({ h: rows, w: cols }).catch(() => {});
    }
  });

  socket.on('exec:stop', () => cleanupExecSession(socket.id));

  // ---- Live container logs ----
  // Streams docker logs -f output for the given container.
  // compose containers have no TTY by default — stream is multiplexed.
  socket.on('logs:start', async ({ containerId }) => {
    cleanupLogSession(socket.id);

    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      if (info.Config?.Labels?.['com.docker-garage.managed'] !== 'true') {
        socket.emit('logs:ended', { error: 'Access denied: not a Docker Garage managed container.' });
        return;
      }
      const stream = await container.logs({
        follow:     true,
        stdout:     true,
        stderr:     true,
        timestamps: false,
        tail:       200,
      });

      logSessions.set(socket.id, stream);

      const emitChunk = { write(chunk) { socket.emit('logs:output', { data: chunk.toString('utf8') }); } };
      docker.modem.demuxStream(stream, emitChunk, emitChunk);

      stream.on('end',   ()    => { logSessions.delete(socket.id); socket.emit('logs:ended', {}); });
      stream.on('error', (err) => { logSessions.delete(socket.id); socket.emit('logs:ended', { error: err.message }); });

    } catch (err) {
      log.error('[Logs] logs:start failed', err);
      socket.emit('logs:ended', { error: err.message });
    }
  });

  socket.on('logs:stop', () => cleanupLogSession(socket.id));

  // testdrive:log / testdrive:done / testdrive:stopped are emitted directly
  // by dockerEngine — no handler needed here.

  socket.on('disconnect', (reason) => {
    cleanupExecSession(socket.id);
    cleanupLogSession(socket.id);
    console.log(`[Socket.io] Client disconnected: ${socket.id} (${reason})`);
  });
});

// =============================================================================
// 6. Start
// =============================================================================

// =============================================================================
// 7. Graceful shutdown — clean up managed containers on stop
// =============================================================================

async function gracefulShutdown(signal) {
  log.info(`[Server] ${signal} received — cleaning up managed containers…`);
  try {
    const count = await terminateAllManaged(null);
    if (count > 0) log.info(`[Server] Terminated ${count} managed container(s).`);
  } catch (err) {
    log.warn(`[Server] Shutdown cleanup failed: ${err.message}`);
  }
  process.exit(0);
}

// Only intercept signals in production — in development nodemon sends SIGTERM
// on every file-save restart, which would kill all test containers each reload.
if (process.env.NODE_ENV === 'production') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

// =============================================================================
// 8. Start — also clean up any orphaned managed containers from a previous run
// =============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  log.banner(`Docker Garage started — http://localhost:${PORT}  [${process.env.NODE_ENV || 'development'}]`);
  log.info(`Log file: ${require('./logger').LOG_FILE}`);

  // Clean up any test containers that survived a previous crash or restart
  terminateAllManaged(null)
    .then((n) => { if (n > 0) log.info(`[Startup] Cleaned up ${n} orphaned managed container(s).`); })
    .catch((err) => log.warn(`[Startup] Startup cleanup skipped: ${err.message}`));
});
