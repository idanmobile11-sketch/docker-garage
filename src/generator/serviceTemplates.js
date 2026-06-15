// =============================================================================
// serviceTemplates.js — Auxiliary Service Definitions
// =============================================================================
// Each key is a service name the user can select in the UI.
// The values are plain JS objects that mirror docker-compose service fields.
// The composeGenerator reads these and renders them into valid YAML.
//
// Best-practice choices made here:
//   - Alpine-based images where available (smaller attack surface)
//   - Named volumes for persistent data (survives container restarts)
//   - Healthchecks so dependent services wait until ready
//   - Env vars use ${VAR:-default} syntax so users can override via .env files
// =============================================================================

const SERVICE_TEMPLATES = {

  // ---------------------------------------------------------------------------
  redis: {
    image: 'redis:7-alpine',
    ports: ['6379:6379'],
    volumes: ['redis_data:/data'],
    // appendonly yes = write-ahead log; data survives redis restarts
    command: 'redis-server --appendonly yes',
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD', 'redis-cli', 'ping'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
      start_period: '10s',
    },
  },

  // ---------------------------------------------------------------------------
  postgres: {
    image: 'postgres:16-alpine',
    ports: ['5432:5432'],
    volumes: ['postgres_data:/var/lib/postgresql/data'],
    environment: {
      POSTGRES_DB:       '${DB_NAME:-myapp_db}',
      POSTGRES_USER:     '${DB_USER:-admin}',
      POSTGRES_PASSWORD: '${DB_PASSWORD:-changeme}',
    },
    restart: 'unless-stopped',
    healthcheck: {
      // pg_isready exits 0 only once the server accepts connections
      test: ['CMD-SHELL', 'pg_isready -U ${DB_USER:-admin}'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
      start_period: '20s',
    },
  },

  // ---------------------------------------------------------------------------
  mysql: {
    image: 'mysql:8',
    ports: ['3306:3306'],
    volumes: ['mysql_data:/var/lib/mysql'],
    environment: {
      MYSQL_ROOT_PASSWORD: '${MYSQL_ROOT_PASSWORD:-rootpass}',
      MYSQL_DATABASE:      '${DB_NAME:-myapp_db}',
      MYSQL_USER:          '${DB_USER:-admin}',
      MYSQL_PASSWORD:      '${DB_PASSWORD:-changeme}',
    },
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
      start_period: '30s',
    },
  },

  // ---------------------------------------------------------------------------
  mongodb: {
    image: 'mongo:7',
    ports: ['27017:27017'],
    volumes: ['mongo_data:/data/db'],
    environment: {
      MONGO_INITDB_ROOT_USERNAME: '${MONGO_USER:-admin}',
      MONGO_INITDB_ROOT_PASSWORD: '${MONGO_PASSWORD:-changeme}',
    },
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD', 'mongosh', '--eval', 'db.adminCommand("ping")'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
      start_period: '20s',
    },
  },

  // ---------------------------------------------------------------------------
  nginx: {
    image: 'nginx:alpine',
    ports: ['80:80', '443:443'],
    // Users must provide their own nginx.conf — the generator will note this
    volumes: ['./nginx.conf:/etc/nginx/nginx.conf:ro'],
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD', 'wget', '--spider', '-q', 'http://localhost/'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      start_period: '10s',
    },
  },

  // ---------------------------------------------------------------------------
  rabbitmq: {
    image: 'rabbitmq:3-management-alpine',
    // 5672 = AMQP protocol, 15672 = management web UI
    ports: ['5672:5672', '15672:15672'],
    volumes: ['rabbitmq_data:/var/lib/rabbitmq'],
    environment: {
      RABBITMQ_DEFAULT_USER: '${RABBITMQ_USER:-admin}',
      RABBITMQ_DEFAULT_PASS: '${RABBITMQ_PASSWORD:-changeme}',
    },
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD', 'rabbitmq-diagnostics', 'ping'],
      interval: '30s',
      timeout: '10s',
      retries: 5,
      start_period: '30s',
    },
  },

  // ---------------------------------------------------------------------------
  elasticsearch: {
    image: 'elasticsearch:8.13.0',
    ports: ['9200:9200'],
    volumes: ['elastic_data:/usr/share/elasticsearch/data'],
    environment: {
      // single-node disables the cluster discovery handshake for local dev
      'discovery.type':        'single-node',
      // disable TLS/auth so local dev tools can connect without certs
      'xpack.security.enabled': 'false',
      // cap heap to avoid OOM on dev machines; tune for production
      ES_JAVA_OPTS:            '-Xms512m -Xmx512m',
    },
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD-SHELL', 'curl -sf http://localhost:9200/_cluster/health || exit 1'],
      interval: '20s',
      timeout: '10s',
      retries: 5,
      // ES takes longer than most services to initialise
      start_period: '60s',
    },
  },

  // ---------------------------------------------------------------------------
  kibana: {
    // Kibana version MUST match your Elasticsearch version exactly
    image: 'kibana:8.13.0',
    // 5601 = Kibana web UI
    ports: ['5601:5601'],
    environment: {
      ELASTICSEARCH_HOSTS: 'http://elasticsearch:9200',
    },
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD-SHELL', 'curl -sf http://localhost:5601/api/status || exit 1'],
      interval: '30s',
      timeout: '10s',
      retries: 5,
      start_period: '60s',
    },
  },

  // ---------------------------------------------------------------------------
  memcached: {
    image: 'memcached:alpine',
    // 11211 = default memcached port
    ports: ['11211:11211'],
    restart: 'unless-stopped',
    // memcached has no built-in health endpoint; use a TCP probe
    healthcheck: {
      test: ['CMD-SHELL', 'echo "stats" | nc -w 1 localhost 11211 || exit 1'],
      interval: '10s',
      timeout: '5s',
      retries: 3,
      start_period: '5s',
    },
  },

  // ---------------------------------------------------------------------------
  minio: {
    image: 'minio/minio:latest',
    // 9000 = S3 API (use this in your app's AWS SDK config)
    // 9001 = MinIO web console (open in browser)
    ports: ['9000:9000', '9001:9001'],
    volumes: ['minio_data:/data'],
    environment: {
      MINIO_ROOT_USER:     '${MINIO_ROOT_USER:-minioadmin}',
      MINIO_ROOT_PASSWORD: '${MINIO_ROOT_PASSWORD:-minioadmin}',
    },
    // 'server /data' = data path, '--console-address' pins the console port
    command: 'server /data --console-address ":9001"',
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD-SHELL', 'curl -sf http://localhost:9000/minio/health/live || exit 1'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      start_period: '15s',
    },
  },

  // ---------------------------------------------------------------------------
  mailpit: {
    // Mailpit = modern dev mail catcher (replaces MailHog)
    // Send emails from your app to smtp://localhost:1025
    // View them in the web UI at http://localhost:8025
    image: 'axllent/mailpit:latest',
    ports: ['1025:1025', '8025:8025'],
    restart: 'unless-stopped',
    healthcheck: {
      test: ['CMD-SHELL', 'wget --spider -q http://localhost:8025 || exit 1'],
      interval: '10s',
      timeout: '5s',
      retries: 3,
      start_period: '5s',
    },
  },

  // ---------------------------------------------------------------------------
  adminer: {
    // Lightweight DB admin UI — works with PostgreSQL, MySQL, MongoDB and more
    // Open http://localhost:8080 and pick your database type to connect
    image: 'adminer:latest',
    ports: ['8080:8080'],
    restart: 'unless-stopped',
  },

};

// The named volumes that each service needs.
// composeGenerator uses this to build the top-level 'volumes:' block.
const SERVICE_VOLUMES = {
  redis:          ['redis_data'],
  postgres:       ['postgres_data'],
  mysql:          ['mysql_data'],
  mongodb:        ['mongo_data'],
  nginx:          [],            // uses a bind mount, not a named volume
  rabbitmq:       ['rabbitmq_data'],
  elasticsearch:  ['elastic_data'],
  kibana:         [],            // stateless; ES holds the data
  memcached:      [],            // in-memory only — nothing to persist
  minio:          ['minio_data'],
  mailpit:        [],            // messages are ephemeral by default
  adminer:        [],            // stateless UI
};

module.exports = { SERVICE_TEMPLATES, SERVICE_VOLUMES };
