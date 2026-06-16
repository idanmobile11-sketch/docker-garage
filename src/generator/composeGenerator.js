// =============================================================================
// composeGenerator.js — docker-compose.yml String Builder
// =============================================================================
// Takes a validated config object and returns a valid docker-compose.yml string.
//
// The generated file follows these DevOps best practices:
//   - Named volumes for all stateful data (no anonymous volumes)
//   - Healthchecks on auxiliary services so the app waits until they are ready
//   - `depends_on: condition: service_healthy` for proper startup ordering
//   - A dedicated named network (bridge or host) isolating the stack
//   - Environment variables with ${VAR:-default} so users can use a .env file
//   - `restart: unless-stopped` for production resilience
// =============================================================================

const { SERVICE_TEMPLATES, SERVICE_VOLUMES } = require('./serviceTemplates');

// Default app ports per base runtime
const DEFAULT_PORTS = { node: 3000, python: 8000, golang: 8080, php: 9000, nginx: 80, ubuntu: 8080 };

// ---------------------------------------------------------------------------
// Minimal YAML serialiser
// ---------------------------------------------------------------------------
// Rather than pulling in a yaml library, we build the string directly.
// This is intentional: it keeps dependencies minimal and makes the output
// format predictable and easy for beginners to understand.

/**
 * Wraps a string in YAML single quotes if it contains characters that would
 * confuse the YAML parser (colons, braces, quotes, etc.).
 *
 * WHY single quotes instead of double quotes:
 *   Double-quoted YAML interprets backslash escapes AND the value may itself
 *   contain double quotes (e.g. MinIO's command: `server /data --console-address ":9001"`).
 *   Wrapping that in double quotes produces broken YAML: `"server … ":9001""`.
 *   Single-quoted YAML is fully literal — the only escape is '' for a literal
 *   single quote — so it handles any content safely.
 */
function yamlStr(s) {
  if (typeof s !== 'string') return String(s);
  // Characters that have special meaning in unquoted YAML scalars
  if (/[:#{}[\],&*?|<>=!%@`"'\r\n]/.test(s) || s.trim() === '') {
    return `'${s.replace(/'/g, "''")}'`; // escape inner single quotes by doubling
  }
  return s;
}

/**
 * Serialise a plain JS value as YAML at the given indent depth.
 * Handles: strings, numbers, booleans, arrays, and plain objects.
 */
function toYaml(value, depth = 0) {
  const pad = '  '.repeat(depth);

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'object' && item !== null) {
        const lines = toYaml(item, depth + 1).split('\n');
        const first = lines[0].trimStart();
        const rest  = lines.slice(1).join('\n');
        return `${pad}- ${first}${rest ? '\n' + rest : ''}`;
      }
      // Quote array scalars too — port mappings like "3000:3000" contain ":"
      return `${pad}- ${yamlStr(String(item))}`;
    }).join('\n');
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([k, v]) => {
      if (k === 'test' && Array.isArray(v)) {
        // Healthcheck test: flow sequence with double-quoted items.
        // Escape backslashes first, then double quotes, so inner " don't break YAML.
        const items = v.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
        return `${pad}${k}: [${items}]`;
      }
      if (Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, depth + 1)}`;
      }
      if (typeof v === 'object' && v !== null) {
        return `${pad}${k}:\n${toYaml(v, depth + 1)}`;
      }
      // Numbers and booleans are safe unquoted
      if (typeof v === 'number' || typeof v === 'boolean') {
        return `${pad}${k}: ${v}`;
      }
      return `${pad}${k}: ${yamlStr(String(v))}`;
    }).join('\n');
  }

  return `${pad}${yamlStr(String(value))}`;
}

// ---------------------------------------------------------------------------
// App service block builder
// ---------------------------------------------------------------------------

function buildAppService(config) {
  const { appName, base, port, services = [], networkDriver, options = {} } = config;
  const appPort = port || DEFAULT_PORTS[base] || 3000;
  const networkName = `${appName}_network`;

  const serviceObj = {
    build: '.',
    container_name: appName,
    ports: [`${appPort}:${appPort}`],
    environment: {
      NODE_ENV: 'production',
      PORT: String(appPort),
    },
    networks: [networkName],
    restart: 'unless-stopped',
  };

  // Named volume for app data (optional)
  if (options.namedVolumes) {
    serviceObj.volumes = [`${appName}_data:/app/data`];
  }

  // depends_on with health checks so the app starts only after services are ready
  const healthCheckedServices = services.filter(
    (s) => SERVICE_TEMPLATES[s]?.healthcheck
  );
  if (healthCheckedServices.length > 0) {
    serviceObj.depends_on = {};
    healthCheckedServices.forEach((s) => {
      serviceObj.depends_on[s] = { condition: 'service_healthy' };
    });
    // Services without healthchecks just need to be started
    const simpleServices = services.filter(
      (s) => !SERVICE_TEMPLATES[s]?.healthcheck
    );
    simpleServices.forEach((s) => {
      serviceObj.depends_on[s] = { condition: 'service_started' };
    });
  }

  return serviceObj;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates a docker-compose.yml string from the given config.
 *
 * @param {object} config
 * @param {string} config.appName          - Project / container name
 * @param {string} config.base             - Base runtime (node, python, …)
 * @param {string} [config.version]        - Runtime version tag
 * @param {number} [config.port]           - Port the app exposes
 * @param {string[]} [config.services]     - Auxiliary services (redis, postgres, …)
 * @param {string} [config.networkDriver]  - 'bridge' (default) or 'host'
 * @param {object} [config.options]
 * @param {boolean} [config.options.namedVolumes]  - Named volume for app data
 * @returns {string} Full docker-compose.yml content
 */
function generateCompose(config) {
  const {
    appName = 'my-app',
    services = [],
    networkDriver = 'bridge',
    options = {},
  } = config;

  const networkName = `${appName}_network`;
  const lines = [];

  // ---- Header ----
  lines.push('# =========================================================');
  lines.push(`# docker-compose.yml — generated by Docker Garage`);
  lines.push(`# App: ${appName}`);
  lines.push('#');
  lines.push('# TIP: Create a .env file in this directory to override any');
  lines.push('# ${VAR:-default} values without editing this file.');
  lines.push('# =========================================================');
  lines.push('');
  lines.push('services:');

  // ---- App service ----
  lines.push('');
  lines.push(`  # Your application container`);
  lines.push(`  ${appName}:`);
  const appService = buildAppService(config);
  lines.push(toYaml(appService, 2));

  // ---- Auxiliary services ----
  services.forEach((serviceName) => {
    const template = SERVICE_TEMPLATES[serviceName];
    if (!template) return;

    lines.push('');
    lines.push(`  # ${serviceName} — auxiliary service`);
    lines.push(`  ${serviceName}:`);

    // Merge in network so the service can communicate with the app
    const serviceWithNetwork = {
      ...template,
      networks: [networkName],
    };

    lines.push(toYaml(serviceWithNetwork, 2));
  });

  // ---- Networks block ----
  lines.push('');
  lines.push('# ---- Networks ----');
  lines.push('# A dedicated network isolates this stack from other containers on the host.');
  lines.push('networks:');
  lines.push(`  ${networkName}:`);
  if (networkDriver === 'host') {
    lines.push(`    driver: host`);
    lines.push('    # NOTE: host network shares the host\'s network stack.');
    lines.push('    # Port mappings ("ports:") are ignored when driver is host.');
  } else {
    lines.push(`    driver: bridge`);
  }

  // ---- Volumes block ----
  const allVolumes = new Set();

  // App named volume
  if (options.namedVolumes) {
    allVolumes.add(`${appName}_data`);
  }

  // Collect volumes required by each selected service
  services.forEach((s) => {
    (SERVICE_VOLUMES[s] || []).forEach((v) => allVolumes.add(v));
  });

  if (allVolumes.size > 0) {
    lines.push('');
    lines.push('# ---- Volumes ----');
    lines.push('# Named volumes persist data across container restarts and recreations.');
    lines.push('# Docker manages them — no host path needed.');
    lines.push('volumes:');
    allVolumes.forEach((v) => {
      lines.push(`  ${v}:  # docker volume inspect ${v}`);
    });
  }

  return lines.join('\n');
}

module.exports = { generateCompose };
