// =============================================================================
// routes/testdrive.js — POST /api/testdrive
// =============================================================================
// Accepts a full config (same shape as /api/generate), generates the files,
// writes them to disk, then TRIGGERS the Test Drive via the Socket.io room
// so the client's terminal starts receiving live logs immediately.
//
// The route itself responds quickly (202 Accepted) — the actual compose work
// happens asynchronously via the WebSocket channel.
//
// Flow:
//   Browser → POST /api/testdrive  { config, socketId }
//                  ↓
//             Generate files (same as /api/generate)
//                  ↓
//             Write to /tmp/docker-garage/<sessionId>/
//                  ↓
//             Emit 'testdrive:start' on the socket
//                  ↓
//             dockerEngine.runComposeUp() streams logs → socket
//                  ↓
//             Browser xterm.js receives 'testdrive:log' events
// =============================================================================

const { Router } = require('express');
const { randomUUID } = require('crypto'); // built into Node.js 14+
const log = require('../logger');

const { generateDockerfile } = require('../generator/dockerfileGenerator');
const { generateCompose }    = require('../generator/composeGenerator');
const {
  writeGeneratedFiles,
  cleanupSessionDir,
  runComposeUp,
  runComposeDown,
  terminateAllManaged,
} = require('../engine/dockerEngine');

const router = Router();

// We need access to the Socket.io `io` instance to look up a socket by ID.
// It is injected via setIo() below — called from index.js after io is created.
let _io = null;
function setIo(io) { _io = io; }

// Track active sessions so the Stop endpoint can find the right directory.
// Map: sessionId → { sessionDir, projectName, socketId }
const activeSessions = new Map();

// ---------------------------------------------------------------------------
// POST /api/testdrive/start
// ---------------------------------------------------------------------------

router.post('/start', async (req, res) => {
  const { config, socketId } = req.body;

  // Basic guards
  if (!config || !config.appName || !config.base) {
    return res.status(400).json({ error: 'config.appName and config.base are required.' });
  }
  if (!socketId) {
    return res.status(400).json({ error: 'socketId is required to stream logs.' });
  }
  if (!_io) {
    return res.status(500).json({ error: 'Socket.io not initialised.' });
  }

  // Look up the client's socket
  const socket = _io.sockets.sockets.get(socketId);
  if (!socket) {
    return res.status(404).json({ error: `Socket ${socketId} not found. Is the browser still connected?` });
  }

  // Generate a unique ID for this test-drive session
  const sessionId = randomUUID();

  // Generate the Dockerfile + compose strings (reuse Phase 2 logic)
  let dockerfile, compose;
  try {
    dockerfile = generateDockerfile(config);
    compose    = generateCompose(config);
  } catch (err) {
    return res.status(500).json({ error: 'Generator failed', message: err.message });
  }

  // Write files to disk
  let sessionDir;
  try {
    sessionDir = writeGeneratedFiles(sessionId, dockerfile, compose);
    log.success(`[TestDrive] Files written — session=${sessionId}`);
  } catch (err) {
    log.error(`[TestDrive] writeGeneratedFiles failed — session=${sessionId}`, err);
    return res.status(500).json({
      error: 'Could not write generated files',
      message: err.message,
      code: err.code,
      hint: err.code === 'ENOENT' || err.code === 'EACCES'
        ? 'Make sure /tmp/docker-garage is bind-mounted in docker-compose.yml and the container was recreated with "docker compose down && docker compose up -d"'
        : undefined,
    });
  }

  // Store session metadata for the Stop endpoint
  activeSessions.set(sessionId, {
    sessionDir,
    projectName: config.appName,
    socketId,
  });

  log.info(`[TestDrive] Session started — id=${sessionId} project=${config.appName} socket=${socketId}`);
  // Acknowledge the client immediately — logs will follow via WebSocket
  res.status(202).json({ sessionId, message: 'Test Drive started. Watch your terminal.' });

  // Run compose up asynchronously (logs stream to the socket)
  runComposeUp({
    sessionId,
    sessionDir,
    projectName: config.appName,
    socket,
  })
    .catch((err) => {
      console.error(`[TestDrive] Session ${sessionId} errored:`, err.message);
      socket.emit('testdrive:log', {
        line: `[Docker Garage] Fatal error: ${err.message}`,
        level: 'error',
        ts: Date.now(),
      });
    })
    .finally(() => {
      // Keep the session dir for a few minutes so users can inspect the files,
      // then clean up. In production you'd want a smarter GC.
      setTimeout(() => {
        cleanupSessionDir(sessionDir);
        activeSessions.delete(sessionId);
      }, 5 * 60 * 1000); // 5 minutes
    });
});

// ---------------------------------------------------------------------------
// POST /api/testdrive/stop
// ---------------------------------------------------------------------------

router.post('/stop', async (req, res) => {
  const { sessionId, socketId } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: `Session ${sessionId} not found or already cleaned up.` });
  }

  const socket = _io?.sockets.sockets.get(socketId || session.socketId);

  res.status(202).json({ message: 'Stop signal sent.' });

  await runComposeDown({
    sessionDir:  session.sessionDir,
    projectName: session.projectName,
    socket:      socket || { emit: () => {} }, // no-op if socket disconnected
  }).catch((err) => console.error('[TestDrive] Stop error:', err.message));
});

// ---------------------------------------------------------------------------
// POST /api/testdrive/terminate
// ---------------------------------------------------------------------------
// Stops and removes ALL containers labelled com.docker-garage.managed=true.
// This covers the current session AND any orphans from previous runs.

router.post('/terminate', async (req, res) => {
  const { socketId } = req.body;
  const socket = socketId ? _io?.sockets.sockets.get(socketId) : null;

  function emitFn(line, level) {
    if (socket) socket.emit('testdrive:log', { line, level, ts: Date.now() });
  }

  res.status(202).json({ message: 'Terminating all managed containers…' });

  try {
    emitFn('[Docker Garage] Terminating all test containers…', 'system');
    const count = await terminateAllManaged(emitFn);
    emitFn(`✅  Terminated ${count} container(s).`, 'success');
    activeSessions.clear();
    if (socket) socket.emit('testdrive:stopped', { projectName: 'all' });
  } catch (err) {
    log.error('[TestDrive] terminate-all failed', err);
    emitFn(`❌  Terminate failed: ${err.message}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// GET /api/testdrive/files/:sessionId
// Returns the generated files for preview in the UI
// ---------------------------------------------------------------------------

router.get('/files/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const fs   = require('fs');
  const path = require('path');

  try {
    const dockerfile = fs.readFileSync(path.join(session.sessionDir, 'Dockerfile'), 'utf8');
    const compose    = fs.readFileSync(path.join(session.sessionDir, 'docker-compose.yml'), 'utf8');
    res.json({ dockerfile, compose });
  } catch {
    res.status(500).json({ error: 'Could not read session files.' });
  }
});

module.exports = { router, setIo };
