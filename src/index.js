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
const { getDockerInfo, listContainers } = require('./engine/dockerEngine');

// =============================================================================
// 1. Express + HTTP server
// =============================================================================
const app    = express();
const server = http.createServer(app);

// =============================================================================
// 2. Socket.io
// =============================================================================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
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

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected  : ${socket.id}`);

  // The client can request a container list update at any time
  socket.on('containers:refresh', async () => {
    try {
      const containers = await listContainers();
      socket.emit('containers:list', { containers });
    } catch (err) {
      socket.emit('containers:list', { containers: [], error: err.message });
    }
  });

  // testdrive:log, testdrive:done, testdrive:stopped are emitted by
  // dockerEngine.runComposeUp() / runComposeDown() directly to the socket
  // — no handler registration needed here, just document them:
  //
  //   testdrive:log     { line, level, ts }   — a single terminal line
  //   testdrive:done    { success, projectName } — compose finished
  //   testdrive:stopped { projectName }        — compose down finished

  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] Client disconnected: ${socket.id} (${reason})`);
  });
});

// =============================================================================
// 6. Start
// =============================================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  log.banner(`Docker Garage started — http://localhost:${PORT}  [${process.env.NODE_ENV || 'development'}]`);
  log.info(`Log file: ${require('./logger').LOG_FILE}`);
});
