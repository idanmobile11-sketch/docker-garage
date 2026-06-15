// =============================================================================
// routes/generate.js — POST /api/generate
// =============================================================================
// Accepts a JSON config payload from the UI (the "Showroom"),
// validates it, then calls the generator functions and returns
// the generated Dockerfile and docker-compose.yml as strings.
//
// Request body shape:
// {
//   "appName":       "my-project",          // required
//   "base":          "node",                // required: node|python|golang|php|nginx|ubuntu
//   "version":       "20",                  // optional: image version tag
//   "port":          3000,                  // optional: app port (number)
//   "services":      ["redis", "postgres"], // optional: auxiliary services
//   "networkDriver": "bridge",              // optional: "bridge" or "host"
//   "options": {
//     "nonRootUser": true,                  // optional: add non-root user
//     "namedVolumes": true,                 // optional: named volume for app data
//     "healthcheck":  true                  // optional: add HEALTHCHECK to Dockerfile
//   }
// }
//
// Success response (200):
// {
//   "dockerfile": "FROM node:20-alpine\n...",
//   "compose":    "services:\n  my-project:\n..."
// }
//
// Error response (400):
// { "error": "Validation failed", "details": [...] }
// =============================================================================

const { Router } = require('express');
const { generateDockerfile } = require('../generator/dockerfileGenerator');
const { generateCompose }    = require('../generator/composeGenerator');

const router = Router();

// ---- Constants ----
const VALID_BASES    = ['node', 'python', 'golang', 'php', 'nginx', 'ubuntu'];
const VALID_SERVICES = [
  'redis', 'postgres', 'mysql', 'mongodb', 'nginx', 'rabbitmq',
  'elasticsearch', 'kibana', 'memcached', 'minio', 'mailpit', 'adminer',
];
const VALID_NETWORKS = ['bridge', 'host'];

// Allowed characters for app names (Docker container name rules)
const APP_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{1,62}$/;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validates the request body and returns a list of human-readable error strings.
 * Returns an empty array if everything is valid.
 */
function validateConfig(body) {
  const errors = [];

  // appName
  if (!body.appName) {
    errors.push('"appName" is required.');
  } else if (!APP_NAME_REGEX.test(body.appName)) {
    errors.push('"appName" must be 2–63 characters, lowercase alphanumeric, hyphens, or underscores.');
  }

  // base
  if (!body.base) {
    errors.push('"base" is required.');
  } else if (!VALID_BASES.includes(body.base)) {
    errors.push(`"base" must be one of: ${VALID_BASES.join(', ')}.`);
  }

  // version (optional, but must be a non-empty string if provided)
  if (body.version !== undefined && (typeof body.version !== 'string' || !body.version.trim())) {
    errors.push('"version" must be a non-empty string if provided.');
  }

  // port (optional, but must be a valid port number if provided)
  if (body.port !== undefined) {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      errors.push('"port" must be an integer between 1 and 65535.');
    }
  }

  // services (optional array of known names)
  if (body.services !== undefined) {
    if (!Array.isArray(body.services)) {
      errors.push('"services" must be an array.');
    } else {
      const unknown = body.services.filter((s) => !VALID_SERVICES.includes(s));
      if (unknown.length > 0) {
        errors.push(`Unknown service(s): ${unknown.join(', ')}. Valid: ${VALID_SERVICES.join(', ')}.`);
      }
      // Guard against nginx being both base and service
      if (body.base === 'nginx' && body.services.includes('nginx')) {
        errors.push('"nginx" cannot be both the base image and an auxiliary service.');
      }
    }
  }

  // networkDriver (optional)
  if (body.networkDriver !== undefined && !VALID_NETWORKS.includes(body.networkDriver)) {
    errors.push(`"networkDriver" must be one of: ${VALID_NETWORKS.join(', ')}.`);
  }

  // options (optional object)
  if (body.options !== undefined) {
    if (typeof body.options !== 'object' || Array.isArray(body.options)) {
      errors.push('"options" must be a plain object.');
    } else {
      const boolFields = ['nonRootUser', 'namedVolumes', 'healthcheck'];
      boolFields.forEach((f) => {
        if (body.options[f] !== undefined && typeof body.options[f] !== 'boolean') {
          errors.push(`"options.${f}" must be a boolean.`);
        }
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/generate
 * Generates a Dockerfile and docker-compose.yml from the given config.
 */
router.post('/generate', (req, res) => {
  const body = req.body;

  // 1. Validate
  const errors = validateConfig(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // 2. Normalise (apply defaults)
  const config = {
    appName:       body.appName,
    base:          body.base,
    version:       body.version || undefined,
    port:          body.port ? Number(body.port) : undefined,
    services:      body.services || [],
    networkDriver: body.networkDriver || 'bridge',
    options: {
      nonRootUser:  body.options?.nonRootUser  ?? true,
      namedVolumes: body.options?.namedVolumes ?? true,
      healthcheck:  body.options?.healthcheck  ?? true,
    },
  };

  // 3. Generate
  try {
    const dockerfile = generateDockerfile(config);
    const compose    = generateCompose(config);

    console.log(`[Generate] Built config for "${config.appName}" (${config.base})`);

    res.json({ dockerfile, compose });
  } catch (err) {
    console.error('[Generate] Generator error:', err);
    res.status(500).json({ error: 'Generator failed', message: err.message });
  }
});

module.exports = router;
