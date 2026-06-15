// =============================================================================
// portChecker.js — Port Availability Checker
// =============================================================================
// Checks whether TCP ports are available by attempting to bind to them.
// Runs inside the container — valid for the WSL2 / Linux network namespace
// that Docker Desktop uses, so it catches sibling-container port conflicts.
// =============================================================================

const net = require('net');

/**
 * Returns true if the port is available to bind.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Checks a list of port numbers and returns their status.
 *
 * @param {number[]} ports
 * @returns {Promise<{ port: number, available: boolean }[]>}
 */
async function checkPorts(ports) {
  return Promise.all(
    ports.map(async (port) => ({
      port,
      available: await isPortAvailable(port),
    }))
  );
}

module.exports = { checkPorts };
