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
const DEFAULT_PORTS = {
  node: 3000, python: 8000, golang: 8080, php: 9000, nginx: 80, ubuntu: 8080,
  ruby: 3000, java: 8080, rust: 8080, bun: 3000, dotnet: 5000,
};

// Maps base name → Docker Hub image tag.
// Used in Test Drive mode so the compose runs the base image directly
// instead of trying to `build: '.'` (which needs source code that doesn't exist yet).
function buildBaseImage(base, version) {
  const map = {
    node:   (v) => `node:${v || '20'}-alpine`,
    python: (v) => `python:${v || '3.12'}-slim`,
    golang: (v) => `golang:${v || '1.22'}-alpine`,
    php:    (v) => `php:${v || '8.3'}-fpm-alpine`,
    nginx:  (v) => `nginx:${v || 'stable'}-alpine`,
    ubuntu: (v) => { const m = { '20': '20.04', '22': '22.04', '24': '24.04' }; return `ubuntu:${m[v] || v || '24.04'}`; },
    ruby:   (v) => `ruby:${v || '3.3'}-alpine`,
    java:   (v) => `eclipse-temurin:${v || '21'}-jdk-alpine`,
    rust:   (v) => `rust:${v || '1.77'}-alpine`,
    bun:    (v) => `oven/bun:${v || '1'}-alpine`,
    dotnet: (v) => `mcr.microsoft.com/dotnet/sdk:${v || '8.0'}`,
  };
  return map[base] ? map[base](version) : `${base}:${version || 'latest'}`;
}

// ---------------------------------------------------------------------------
// Network topology helpers
// ---------------------------------------------------------------------------

// Services that belong in the DB tier (most sensitive — isolated in 'full' topology)
const DB_TIER  = new Set(['postgres', 'mysql', 'mongodb', 'elasticsearch']);
// Services that belong in the web tier (nginx as a reverse proxy)
const WEB_TIER = new Set(['nginx']);
// Everything else (redis, memcached, rabbitmq, mailpit, adminer, minio, kibana) → app tier

/**
 * Returns named network identifiers for a given topology.
 * @param {string} appName
 * @param {'flat'|'segmented'|'full'} topology
 */
function buildNetworkNames(appName, topology) {
  switch (topology) {
    case 'segmented': return { web: `${appName}_web`, internal: `${appName}_internal` };
    case 'full':      return { web: `${appName}_web`, app: `${appName}_app`, db: `${appName}_db` };
    default:          return { flat: `${appName}_network` };
  }
}

/** Networks the app container itself joins (it bridges all tiers). */
function buildAppNetworks(topology, nets) {
  switch (topology) {
    case 'segmented': return [nets.web, nets.internal];
    case 'full':      return [nets.web, nets.app, nets.db];
    default:          return [nets.flat];
  }
}

/** Network(s) that an auxiliary service belongs to. */
function buildServiceNetworks(serviceName, topology, nets) {
  if (topology === 'flat')      return [nets.flat];
  if (topology === 'segmented') return WEB_TIER.has(serviceName) ? [nets.web] : [nets.internal];
  if (topology === 'full') {
    if (WEB_TIER.has(serviceName)) return [nets.web];
    if (DB_TIER.has(serviceName))  return [nets.db];
    return [nets.app];
  }
  return [nets.flat];
}

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
  // YAML 1.2 reserved literals — must be quoted when used as strings
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) {
    return `'${s}'`;
  }
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
  const { appName, base, version, port, services = [], options = {}, _appNetworks, _testDriveMode } = config;
  const appPort = port || DEFAULT_PORTS[base] || 3000;

  const serviceObj = {};

  if (_testDriveMode) {
    // In Test Drive we don't have source code, so skip the build step entirely.
    // Pull and run the base image directly with a sleep process so the container
    // stays alive and all dependency health checks can complete.
    serviceObj.image   = buildBaseImage(base, version);
    serviceObj.command = 'tail -f /dev/null';
  } else {
    serviceObj.build = '.';
  }

  serviceObj.container_name = appName;
  serviceObj.labels         = { 'com.docker-garage.managed': 'true' };
  serviceObj.ports          = [`${appPort}:${appPort}`];
  serviceObj.environment    = { NODE_ENV: 'production', PORT: String(appPort) };
  serviceObj.networks       = _appNetworks || [`${appName}_network`];
  serviceObj.restart        = 'unless-stopped';

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
    networkTopology = 'flat',
    options = {},
    _testDriveMode = false,
  } = config;

  // host driver shares the host network stack — named networks don't apply
  const topology = networkDriver === 'host' ? 'flat' : networkTopology;
  const nets     = buildNetworkNames(appName, topology);
  const appNets  = buildAppNetworks(topology, nets);

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
  const appService = buildAppService({ ...config, _appNetworks: appNets, _testDriveMode });
  lines.push(toYaml(appService, 2));

  // ---- Auxiliary services ----
  services.forEach((serviceName) => {
    const template = SERVICE_TEMPLATES[serviceName];
    if (!template) return;

    const svcNets = buildServiceNetworks(serviceName, topology, nets);

    lines.push('');
    lines.push(`  # ${serviceName} — auxiliary service`);
    lines.push(`  ${serviceName}:`);

    const serviceWithNetwork = {
      ...template,
      labels: { ...(template.labels || {}), 'com.docker-garage.managed': 'true' },
      networks: svcNets,
    };

    lines.push(toYaml(serviceWithNetwork, 2));
  });

  // ---- Networks block ----
  lines.push('');
  lines.push('# ---- Networks ----');

  if (networkDriver === 'host') {
    lines.push('# host driver: shares the host network stack directly.');
    lines.push('# Port mappings ("ports:") are ignored in host mode.');
    lines.push('networks:');
    lines.push(`  ${nets.flat}:`);
    lines.push(`    driver: host`);
  } else if (topology === 'flat') {
    lines.push('# Single shared network — all services can reach each other.');
    lines.push('networks:');
    lines.push(`  ${nets.flat}:`);
    lines.push(`    driver: bridge`);
  } else if (topology === 'segmented') {
    lines.push('# Two-network topology: web-facing tier and internal tier.');
    lines.push('# Your app bridges both. Nginx (if used) cannot reach the database directly.');
    lines.push('networks:');
    lines.push(`  ${nets.web}:    # web tier — nginx + app`);
    lines.push(`    driver: bridge`);
    lines.push(`  ${nets.internal}: # internal tier — app + all services`);
    lines.push(`    driver: bridge`);
  } else if (topology === 'full') {
    lines.push('# Three-network topology: web / app / db tiers.');
    lines.push('# Your app bridges all three. The database is reachable ONLY from your app.');
    lines.push('networks:');
    lines.push(`  ${nets.web}: # web tier — nginx + app`);
    lines.push(`    driver: bridge`);
    lines.push(`  ${nets.app}: # application tier — app + cache/queue/mail services`);
    lines.push(`    driver: bridge`);
    lines.push(`  ${nets.db}:  # data tier — app + database services only`);
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
