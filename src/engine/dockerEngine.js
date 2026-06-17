// =============================================================================
// engine/dockerEngine.js — Docker Execution Engine
// =============================================================================
// This module is the bridge between the generator output (Dockerfile strings)
// and the real Docker daemon running on the host.
//
// How it works (Docker-outside-of-Docker / DooD):
//   1. We write the generated Dockerfile + docker-compose.yml to disk
//      inside a temp directory on the HOST (via the volume mount).
//   2. We call `docker compose up -d --build` on that directory using
//      dockerode's container.exec() — running it inside the Docker CLI
//      container, but the spawned services land on the HOST daemon.
//   3. Every log line is emitted as a Socket.io event so the browser
//      xterm.js terminal receives it in real time.
//
// Key dependency: dockerode
//   docker.modem.followProgress() demuxes the raw Docker stream into
//   discrete log lines we can forward to the client.
// =============================================================================

const Docker = require('dockerode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const log    = require('../logger');

// Connect to the host Docker daemon via the mounted socket.
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Root directory where per-session generated files are stored.
// This path must be visible to the HOST (not just the container) so that
// when we run docker compose, the host daemon can build from it.
// We use /tmp inside the container which maps to host /tmp via the volume.
const GENERATED_ROOT = process.env.GENERATED_ROOT || '/tmp/docker-garage';

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/**
 * Writes the generated Dockerfile and docker-compose.yml to a temp directory.
 * Returns the absolute path to that directory.
 *
 * @param {string} sessionId  - Unique ID for this test-drive session
 * @param {string} dockerfile - Dockerfile content string
 * @param {string} compose    - docker-compose.yml content string
 * @returns {string} Path to the session directory
 */
function writeGeneratedFiles(sessionId, dockerfile, compose) {
  const sessionDir = path.join(GENERATED_ROOT, sessionId);

  log.info(`[Engine] Writing generated files to: ${sessionDir}`);
  log.info(`[Engine] GENERATED_ROOT = ${GENERATED_ROOT}`);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    log.info(`[Engine] Directory created: ${sessionDir}`);
  } catch (err) {
    log.error(`[Engine] mkdirSync failed for ${sessionDir}`, err);
    throw err;
  }

  try {
    fs.writeFileSync(path.join(sessionDir, 'Dockerfile'), dockerfile, 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'docker-compose.yml'), compose, 'utf8');
    log.success(`[Engine] Files written: Dockerfile + docker-compose.yml`);
  } catch (err) {
    log.error(`[Engine] writeFileSync failed in ${sessionDir}`, err);
    throw err;
  }

  return sessionDir;
}

/**
 * Removes the session directory after a test drive completes or fails.
 */
function cleanupSessionDir(sessionDir) {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Engine] Cleanup failed for ${sessionDir}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Docker info
// ---------------------------------------------------------------------------

/**
 * Returns basic Docker daemon info (used by the /api/health route).
 */
async function getDockerInfo() {
  return docker.info();
}

// ---------------------------------------------------------------------------
// Log stream helpers
// ---------------------------------------------------------------------------

/**
 * Sends a formatted log line to the client via Socket.io.
 *
 * @param {object} socket   - Socket.io socket for the session
 * @param {string} line     - Text to display in the terminal
 * @param {string} [level]  - 'info' | 'success' | 'error' | 'system'
 */
function emitLog(socket, line, level = 'info') {
  socket.emit('testdrive:log', { line, level, ts: Date.now() });
  // Mirror non-empty lines to the log file so errors are visible without browser access
  if (line.trim()) {
    if (level === 'error') log.error(`[Compose] ${line}`);
    else                   log.info(`[Compose] ${line}`);
  }
}

/**
 * Checks whether an image is already in the local Docker cache.
 * Returns { image, cached: bool }.
 */
async function checkImageCached(image) {
  try {
    await docker.getImage(image).inspect();
    return { image, cached: true };
  } catch {
    return { image, cached: false };
  }
}

// ---------------------------------------------------------------------------
// Core: run docker compose up
// ---------------------------------------------------------------------------

/**
 * Pulls + builds + starts the generated stack using `docker compose up`.
 * Streams all output to the client in real time via the provided socket.
 *
 * Strategy: we use dockerode to run a docker:cli container that executes
 * `docker compose up --build` against the generated files. The Docker socket
 * is bind-mounted into that runner container so it talks to the HOST daemon.
 *
 * @param {object} opts
 * @param {string} opts.sessionId    - Unique session identifier
 * @param {string} opts.sessionDir   - Path to the generated files (HOST path)
 * @param {string} opts.projectName  - App / compose project name
 * @param {object} opts.socket       - Socket.io socket for the client
 * @returns {Promise<void>}
 */
async function runComposeUp({ sessionId, sessionDir, projectName, socket }) {
  log.info(`[Engine] runComposeUp — session=${sessionId} project=${projectName} dir=${sessionDir}`);
  emitLog(socket, `[Docker Garage] Starting Test Drive for "${projectName}"`, 'system');
  emitLog(socket, `[Docker Garage] Generated files at: ${sessionDir}`, 'system');
  emitLog(socket, '', 'info');

  // We run `docker compose up` by exec-ing a shell command inside a temporary
  // docker/compose container — this is the safest cross-platform approach
  // because it avoids needing the docker CLI on the host PATH inside our container.
  //
  // The compose file is mounted from the host via a bind mount.
  // The Docker socket is also passed through (DooD).

  const cmd = [
    'sh', '-c',
    `docker compose -p ${projectName} -f /workspace/docker-compose.yml up -d --build 2>&1`,
  ];

  emitLog(socket, `$ docker compose up -d --build`, 'system');
  emitLog(socket, '─'.repeat(50), 'system');

  let runner;
  try {
    // Create a temporary container with docker CLI + our files mounted
    runner = await docker.createContainer({
      Image: 'docker:cli',       // Alpine image with docker CLI pre-installed
      Cmd: cmd,
      HostConfig: {
        Binds: [
          // Mount the generated files so compose can read them
          `${sessionDir}:/workspace:ro`,
          // Mount the host Docker socket so compose can talk to the daemon
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        AutoRemove: true,        // clean up the runner container automatically
      },
      Tty: false,
    });

    // Attach to container stdout/stderr BEFORE starting
    const stream = await runner.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    // Start the container
    await runner.start();

    emitLog(socket, '[Docker Garage] Streaming compose output…', 'system');

    // Stream log lines to the client as they arrive
    await new Promise((resolve, reject) => {
      // demuxStream separates stdout/stderr from the Docker multiplexed stream
      docker.modem.demuxStream(
        stream,
        // stdout handler
        {
          write(chunk) {
            const text = chunk.toString('utf8');
            text.split('\n').forEach((line) => {
              if (line.trim()) emitLog(socket, line, 'info');
            });
          },
        },
        // stderr handler (compose sends most output to stderr)
        {
          write(chunk) {
            const text = chunk.toString('utf8');
            text.split('\n').forEach((line) => {
              if (line.trim()) emitLog(socket, line, 'info');
            });
          },
        }
      );

      stream.on('end', resolve);
      stream.on('error', reject);
    });

    // Wait for the runner container to finish and get its exit code
    const result = await runner.wait();
    const exitCode = result.StatusCode;

    emitLog(socket, '─'.repeat(50), 'system');

    if (exitCode === 0) {
      log.success(`[Engine] Stack "${projectName}" is up (session=${sessionId})`);
      emitLog(socket, '', 'info');
      emitLog(socket, `✅  Stack "${projectName}" is up and running!`, 'success');
      emitLog(socket, `    Run "docker ps" on your host to see the containers.`, 'success');
      socket.emit('testdrive:done', { success: true, projectName });
    } else {
      log.error(`[Engine] compose exited with code ${exitCode} for project "${projectName}"`);
      emitLog(socket, `❌  docker compose exited with code ${exitCode}`, 'error');
      socket.emit('testdrive:done', { success: false, exitCode });
    }
  } catch (err) {
    log.error(`[Engine] runComposeUp failed for "${projectName}"`, err);
    if (err.statusCode === 404) {
      emitLog(socket, `❌  Image "docker:cli" not found. Pulling it now…`, 'error');
      await pullDockerCliImage(socket);
      emitLog(socket, `    Image pulled. Please click "Test Drive" again.`, 'system');
    } else {
      emitLog(socket, `❌  Engine error: ${err.message}`, 'error');
    }
    socket.emit('testdrive:done', { success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Pull docker:cli image if missing
// ---------------------------------------------------------------------------

/**
 * Pulls the `docker:cli` image and streams pull progress to the socket.
 * This only runs once — after the image is cached locally it is instant.
 */
async function pullDockerCliImage(socket) {
  emitLog(socket, '[Docker Garage] Pulling docker:cli image (one-time setup)…', 'system');

  await new Promise((resolve, reject) => {
    docker.pull('docker:cli', (err, stream) => {
      if (err) return reject(err);

      docker.modem.followProgress(
        stream,
        // onFinished
        (finishErr) => {
          if (finishErr) return reject(finishErr);
          emitLog(socket, '[Docker Garage] docker:cli image ready.', 'success');
          resolve();
        },
        // onProgress
        (event) => {
          const msg = [event.status, event.progress].filter(Boolean).join(' ');
          if (msg.trim()) emitLog(socket, msg, 'info');
        }
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Stop a running stack
// ---------------------------------------------------------------------------

/**
 * Runs `docker compose down` for the given project.
 * Streams output to the socket just like runComposeUp.
 */
async function runComposeDown({ sessionDir, projectName, socket }) {
  emitLog(socket, `[Docker Garage] Stopping stack "${projectName}"…`, 'system');

  const cmd = [
    'sh', '-c',
    `docker compose -p ${projectName} -f /workspace/docker-compose.yml down 2>&1`,
  ];

  try {
    const runner = await docker.createContainer({
      Image: 'docker:cli',
      Cmd: cmd,
      HostConfig: {
        Binds: [
          `${sessionDir}:/workspace:ro`,
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        AutoRemove: true,
      },
      Tty: false,
    });

    const stream = await runner.attach({ stream: true, stdout: true, stderr: true });
    await runner.start();

    await new Promise((resolve, reject) => {
      docker.modem.demuxStream(
        stream,
        { write(chunk) { chunk.toString('utf8').split('\n').forEach((l) => { if (l.trim()) emitLog(socket, l, 'info'); }); } },
        { write(chunk) { chunk.toString('utf8').split('\n').forEach((l) => { if (l.trim()) emitLog(socket, l, 'info'); }); } }
      );
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    await runner.wait();
    emitLog(socket, `✅  Stack "${projectName}" stopped.`, 'success');
    socket.emit('testdrive:stopped', { projectName });
  } catch (err) {
    emitLog(socket, `❌  Stop failed: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// List running containers on the host
// ---------------------------------------------------------------------------

/**
 * Returns managed (Docker Garage generated) containers for the sidebar/UI.
 * Filters by label so only test-drive containers appear, not unrelated Docker containers.
 * Uses `all: true` so crashed/exited containers are visible too.
 *
 * Field names match the raw Docker API shape so renderStackPanel works without remapping.
 */
async function listContainers() {
  const containers = await docker.listContainers({
    all:     true,
    filters: { label: ['com.docker-garage.managed=true'] },
  });
  return containers.map((c) => ({
    Id:     c.Id.slice(0, 12),
    Names:  c.Names,    // ["/my-app"] — renderStackPanel strips the leading /
    Image:  c.Image,
    State:  c.State,    // 'running' | 'exited' | 'created' — drives the badge colour
    Status: c.Status,   // 'Up 2 hours' — human-readable tooltip
    Ports:  c.Ports,
  }));
}

// ---------------------------------------------------------------------------
// Terminate all Docker Garage managed containers
// ---------------------------------------------------------------------------

/**
 * Stops and removes every container that Docker Garage created.
 *
 * Two detection strategies are combined so both old and new containers are caught:
 *   1. Custom label com.docker-garage.managed=true  — added by current generator
 *   2. Compose working-directory label pointing at GENERATED_ROOT — catches containers
 *      created before the label was added, because Docker Compose automatically
 *      stamps every container with com.docker.compose.project.working_dir.
 *
 * @param {Function|null} emitFn  Optional (line, level) callback for live log output.
 * @returns {Promise<number>}     Count of containers removed.
 */
async function terminateAllManaged(emitFn) {
  // Two parallel queries — one per detection strategy
  const [byLabel, byWorkDir] = await Promise.all([
    docker.listContainers({
      all:     true,
      filters: { label: ['com.docker-garage.managed=true'] },
    }).catch(() => []),
    docker.listContainers({
      all:     true,
      // Any container stamped with a working-dir label (set by docker compose)
      filters: { label: ['com.docker.compose.project.working_dir'] },
    }).catch(() => []),
  ]);

  // Keep only byWorkDir entries whose working dir is inside GENERATED_ROOT
  const workDirMatches = byWorkDir.filter((c) =>
    (c.Labels?.['com.docker.compose.project.working_dir'] || '').startsWith(GENERATED_ROOT)
  );

  // Merge and deduplicate by container ID
  const seen = new Set();
  const all  = [...byLabel, ...workDirMatches].filter((c) => {
    if (seen.has(c.Id)) return false;
    seen.add(c.Id);
    return true;
  });

  let count = 0;
  for (const info of all) {
    const container = docker.getContainer(info.Id);
    const name = (info.Names?.[0] || info.Id.slice(0, 12)).replace(/^\//, '');
    try {
      if (info.State === 'running') await container.stop({ t: 5 });
      await container.remove({ force: true });
      if (emitFn) emitFn(`Removed: ${name}`, 'system');
      count++;
    } catch {
      // Already gone or race — not fatal
    }
  }
  return count;
}

module.exports = {
  docker,
  getDockerInfo,
  writeGeneratedFiles,
  cleanupSessionDir,
  runComposeUp,
  runComposeDown,
  listContainers,
  terminateAllManaged,
  checkImageCached,
  GENERATED_ROOT,
};
