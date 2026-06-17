// =============================================================================
// routes/preflight.js — GET /api/preflight
// =============================================================================
// Runs fast checks before a Test Drive so the UI can warn the user about
// problems upfront rather than mid-run:
//
//   1. Image cache  — is each required image already pulled locally?
//      (not pulled → will need a download on first run, shown as a warning)
//
//   2. Port check   — are the ports the stack wants to bind actually free?
//      (port in use → compose up will fail immediately with a confusing error)
//
// POST body: same config object used by /api/generate
// Response : { images: [...], ports: [...] }
// =============================================================================

const { Router }          = require('express');
const { generateDockerfile } = require('../generator/dockerfileGenerator');
const { generateCompose }    = require('../generator/composeGenerator');
const { SERVICE_TEMPLATES }  = require('../generator/serviceTemplates');
const { checkImageCached }   = require('../engine/dockerEngine');
const { checkPorts }         = require('../engine/portChecker');

// Known image for each base runtime — mirrors BASE_IMAGES in dockerfileGenerator
// (duplicated here to avoid coupling the route to generator internals)
const BASE_IMAGE_MAP = {
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

const router = Router();

router.post('/', async (req, res) => {
  const config = req.body || {};
  const { base, version, services = [], port } = config;

  // ---- Collect all images this config needs ----
  const imageChecks = [];

  // 1. App base image
  if (base && BASE_IMAGE_MAP[base]) {
    imageChecks.push({ label: `Base (${base})`, image: BASE_IMAGE_MAP[base](version) });
  }

  // 2. docker:cli runner (always needed)
  imageChecks.push({ label: 'docker:cli runner', image: 'docker:cli' });

  // 3. Each selected service
  services.forEach((svc) => {
    const tmpl = SERVICE_TEMPLATES[svc];
    if (tmpl?.image) {
      imageChecks.push({ label: svc, image: tmpl.image });
    }
  });

  // ---- Collect all ports this config needs ----
  const DEFAULT_PORTS = {
    node: 3000, python: 8000, golang: 8080, php: 9000, nginx: 80, ubuntu: 8080,
    ruby: 3000, java: 8080, rust: 8080, bun: 3000, dotnet: 5000,
  };
  const portSet = new Set();

  // App port
  const appPort = port || DEFAULT_PORTS[base] || 3000;
  portSet.add({ port: appPort, label: 'App' });

  // Service ports
  services.forEach((svc) => {
    const tmpl = SERVICE_TEMPLATES[svc];
    if (tmpl?.ports) {
      tmpl.ports.forEach((mapping) => {
        const hostPort = parseInt(String(mapping).split(':')[0]);
        if (!isNaN(hostPort)) portSet.add({ port: hostPort, label: svc });
      });
    }
  });

  // ---- Run both checks in parallel ----
  const [imageResults, portResults] = await Promise.all([
    Promise.all(
      imageChecks.map(async ({ label, image }) => ({
        label,
        image,
        ...(await checkImageCached(image)),
      }))
    ),
    checkPorts([...portSet].map((p) => p.port)).then((results) =>
      results.map((r, i) => ({ ...r, label: [...portSet][i].label }))
    ),
  ]);

  res.json({ images: imageResults, ports: portResults });
});

module.exports = router;
