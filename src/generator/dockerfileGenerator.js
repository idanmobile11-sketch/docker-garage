// =============================================================================
// dockerfileGenerator.js — Dockerfile String Builder
// =============================================================================
// Takes a validated config object and returns a fully-formed Dockerfile string
// with beginner-friendly comments explaining every instruction.
//
// Supported bases:
//   node    → node:{version}-alpine
//   python  → python:{version}-alpine
//   golang  → golang:{version}-alpine   (multi-stage build)
//   php     → php:{version}-fpm-alpine
//   nginx   → nginx:{version}-alpine
//   ubuntu  → ubuntu:{version}
// =============================================================================

// Ubuntu only publishes tags with minor versions (20.04, 22.04, 24.04).
// Typing "20" or "22" is natural but breaks the pull — expand automatically.
function ubuntuTag(v) {
  if (!v) return '24.04';
  const map = { '20': '20.04', '22': '22.04', '24': '24.04' };
  return map[v] || v;
}

// Maps a base name to its Docker Hub image (Alpine where possible for size)
const BASE_IMAGES = {
  node:   (v) => `node:${v || '20'}-alpine`,
  python: (v) => `python:${v || '3.12'}-slim`,
  golang: (v) => `golang:${v || '1.22'}-alpine`,
  php:    (v) => `php:${v || '8.3'}-fpm-alpine`,
  nginx:  (v) => `nginx:${v || 'stable'}-alpine`,
  ubuntu: (v) => `ubuntu:${ubuntuTag(v)}`,
  ruby:   (v) => `ruby:${v || '3.3'}-alpine`,
  java:   (v) => `eclipse-temurin:${v || '21'}-jdk-alpine`,
  rust:   (v) => `rust:${v || '1.77'}-alpine`,
  bun:    (v) => `oven/bun:${v || '1'}-alpine`,
  dotnet: (v) => `mcr.microsoft.com/dotnet/sdk:${v || '8.0'}`,
};

// Default ports for each base (used if the user didn't specify one)
const DEFAULT_PORTS = {
  node:   3000,
  python: 8000,
  golang: 8080,
  php:    9000,
  nginx:  80,
  ubuntu: 8080,
  ruby:   3000,
  java:   8080,
  rust:   8080,
  bun:    3000,
  dotnet: 5000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns true if the base image is Alpine-based.
// Alpine uses `addgroup`/`adduser` instead of `groupadd`/`useradd`.
function isAlpine(base) {
  return ['node', 'golang', 'php', 'nginx', 'ruby', 'java', 'rust', 'bun'].includes(base);
}

// Builds lines for creating a non-root user depending on the base OS
function nonRootUserLines(base) {
  if (base === 'ubuntu') {
    return [
      '# Security best practice: run the app as a non-root user.',
      'RUN groupadd -r appgroup && useradd -r -g appgroup appuser',
    ];
  }
  // python:slim is Debian-based
  if (base === 'python') {
    return [
      '# Security best practice: run the app as a non-root user.',
      'RUN groupadd -r appgroup && useradd -r -g appgroup --no-create-home appuser',
    ];
  }
  // Alpine-based images use BusyBox addgroup/adduser
  return [
    '# Security best practice: run the app as a non-root user.',
    '# Alpine uses addgroup/adduser (BusyBox versions, slightly different flags)',
    'RUN addgroup -S appgroup && adduser -S appuser -G appgroup',
  ];
}

// Builds the dependency-install block for each base
function dependencyLines(base) {
  switch (base) {
    case 'node':
      return [
        '# Copy ONLY the package manifest files first.',
        '# Docker caches this layer so npm install only re-runs when',
        '# package.json or package-lock.json changes — not on every code edit.',
        'COPY package*.json ./',
        '',
        '# --omit=dev skips devDependencies for a leaner production image.',
        'RUN npm ci --omit=dev',
        '',
        '# Now copy the rest of the source code.',
        'COPY . .',
      ];

    case 'python':
      return [
        '# Copy requirements first for layer-cache optimisation.',
        'COPY requirements.txt ./',
        '',
        '# --no-cache-dir keeps the image smaller by not storing pip\'s download cache.',
        'RUN pip install --no-cache-dir -r requirements.txt',
        '',
        'COPY . .',
      ];

    case 'golang':
      return [
        '# Copy go.mod and go.sum first so "go mod download" is cached separately.',
        'COPY go.mod go.sum ./',
        'RUN go mod download',
        '',
        'COPY . .',
        '',
        '# Compile a static binary. CGO_ENABLED=0 avoids glibc dependency.',
        'RUN CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/app .',
      ];

    case 'php':
      return [
        'COPY composer.json composer.lock ./',
        '# --no-dev skips development packages, --no-interaction runs without prompts.',
        'RUN composer install --no-dev --no-interaction --prefer-dist',
        '',
        'COPY . .',
      ];

    case 'nginx':
      return [
        '# Copy your static site or custom nginx config into the image.',
        'COPY ./public /usr/share/nginx/html',
        'COPY ./nginx.conf /etc/nginx/nginx.conf',
      ];

    case 'ruby':
      return [
        'COPY Gemfile Gemfile.lock ./',
        'RUN bundle install --without development test',
        '',
        'COPY . .',
      ];

    case 'java':
      return [
        '# Copy the pre-built JAR (run "mvn package" or "gradle build" first).',
        'COPY target/*.jar app.jar',
      ];

    case 'rust':
      return [
        'COPY Cargo.toml Cargo.lock ./',
        '# Pre-fetch dependencies for layer caching.',
        'RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -rf src',
        '',
        'COPY . .',
        'RUN cargo build --release',
        'RUN cp target/release/$(ls target/release/ | grep -v "\\." | head -1) /usr/local/bin/app',
      ];

    case 'bun':
      return [
        'COPY package.json bun.lockb* ./',
        'RUN bun install --frozen-lockfile',
        '',
        'COPY . .',
      ];

    case 'dotnet':
      return [
        'COPY *.csproj ./',
        'RUN dotnet restore',
        '',
        'COPY . .',
        'RUN dotnet publish -c Release -o /app/publish',
        'WORKDIR /app/publish',
      ];

    default: // ubuntu or unknown
      return ['COPY . .'];
  }
}

// Builds the CMD instruction for each base (or uses a custom command)
function cmdLine(base, customCmd) {
  if (customCmd && customCmd.trim()) {
    const parts = customCmd.trim().split(/\s+/);
    return 'CMD [' + parts.map(p => `"${p}"`).join(', ') + ']';
  }
  const cmds = {
    node:   'CMD ["node", "src/index.js"]',
    python: 'CMD ["python", "app.py"]',
    golang: 'CMD ["/usr/local/bin/app"]',
    php:    'CMD ["php-fpm"]',
    nginx:  'CMD ["nginx", "-g", "daemon off;"]',
    ubuntu: 'CMD ["/bin/bash"]',
    ruby:   'CMD ["ruby", "app.rb"]',
    java:   'CMD ["java", "-jar", "app.jar"]',
    rust:   'CMD ["/usr/local/bin/app"]',
    bun:    'CMD ["bun", "run", "start"]',
    dotnet: 'CMD ["dotnet", "app.dll"]',
  };
  return cmds[base] || 'CMD ["/bin/sh"]';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates a Dockerfile string from the given config.
 *
 * @param {object} config
 * @param {string} config.base          - One of: node, python, golang, php, nginx, ubuntu
 * @param {string} [config.version]     - Image version tag (e.g. "20", "3.12")
 * @param {string} [config.appName]     - Project name used in the LABEL
 * @param {number} [config.port]        - Port the app listens on
 * @param {object} [config.options]
 * @param {boolean} [config.options.nonRootUser]  - Add a non-root user
 * @param {boolean} [config.options.healthcheck]  - Add a HEALTHCHECK instruction
 * @returns {string} Full Dockerfile content
 */
function generateDockerfile(config) {
  const { base, version, appName = 'my-app', options = {}, customCmd } = config;
  const port = config.port || DEFAULT_PORTS[base] || 3000;
  const image = BASE_IMAGES[base] ? BASE_IMAGES[base](version) : `${base}:${version || 'latest'}`;

  // We accumulate lines into this array, then join with newlines at the end.
  const lines = [];

  // ---- Header ----
  lines.push('# =========================================================');
  lines.push(`# Dockerfile — generated by Docker Garage`);
  lines.push(`# App: ${appName}   Base: ${image}`);
  lines.push('# =========================================================');
  lines.push('');

  // ---- FROM ----
  lines.push(`FROM ${image}`);
  lines.push('');

  // ---- LABEL ----
  lines.push('# Labels are metadata — useful for image management and CI/CD.');
  lines.push(`LABEL app="${appName}" generator="docker-garage"`);
  lines.push('');

  // ---- Non-root user (before WORKDIR so chown works) ----
  if (options.nonRootUser) {
    nonRootUserLines(base).forEach((l) => lines.push(l));
    lines.push('');
  }

  // ---- WORKDIR ----
  lines.push('# Set the working directory inside the container.');
  lines.push('# All subsequent COPY, RUN, CMD instructions run relative to this path.');
  lines.push('WORKDIR /app');
  lines.push('');

  // ---- Dependency install + COPY ----
  dependencyLines(base).forEach((l) => lines.push(l));
  lines.push('');

  // ---- Transfer ownership to non-root user ----
  if (options.nonRootUser) {
    lines.push('# Give the non-root user ownership of the app directory.');
    lines.push('RUN chown -R appuser:appgroup /app');
    lines.push('');
    lines.push('# Switch from root to the non-root user for all following commands.');
    lines.push('USER appuser');
    lines.push('');
  }

  // ---- EXPOSE ----
  lines.push(`# Document which port the app listens on (informational — does not open the port).`);
  lines.push(`# The actual port mapping is done in docker-compose.yml with "ports:".`);
  lines.push(`EXPOSE ${port}`);
  lines.push('');

  // ---- HEALTHCHECK ----
  if (options.healthcheck && base !== 'nginx') {
    lines.push('# HEALTHCHECK lets Docker know whether the container is truly ready.');
    lines.push('# Docker will mark the container "unhealthy" if this command fails.');
    lines.push(`HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \\`);
    lines.push(`  CMD wget --no-verbose --tries=1 --spider http://localhost:${port}/health || exit 1`);
    lines.push('');
  }

  // ---- CMD ----
  lines.push('# The default command to run when the container starts.');
  lines.push('# Can be overridden with "command:" in docker-compose.yml.');
  lines.push(cmdLine(base, customCmd));

  return lines.join('\n');
}

module.exports = { generateDockerfile };
