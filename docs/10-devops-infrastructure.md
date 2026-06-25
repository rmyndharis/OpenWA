# 10 - DevOps & Infrastructure

> **⚠️ Conceptual reference (M9).** Some examples here predate the shipped runtime and may not
> match it exactly. The **authoritative** sources are the repo's `Dockerfile`, `docker-compose.yml`
> (Docker socket-proxy threat model, gosu non-root drop, loopback-bound datastores, container
> hardening), and `.env.example` (canonical env var names). Where this doc and those disagree,
> the files win. In particular: the API master key env is `API_MASTER_KEY`, datastores have no
> default credentials, and production migrations use `npm run migration:run:prod`.

## 10.1 Infrastructure Overview

```mermaid
flowchart TB
    subgraph Development["Development"]
        DEV[Local Docker Compose]
    end
    
    subgraph Staging["Staging"]
        STG[Single Server]
    end
    
    subgraph Production["Production"]
        LB[Load Balancer]
        LB --> APP1[App Instance 1]
        LB --> APP2[App Instance 2]
        APP1 --> DB[(PostgreSQL)]
        APP2 --> DB
        APP1 --> REDIS[(Redis)]
        APP2 --> REDIS
    end
    
    DEV --> |deploy| STG
    STG --> |promote| Production
```

## 10.2 Docker Configuration

### Dockerfile

```dockerfile
# Dockerfile (multi-stage build)

# Build stage
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage
FROM node:22-slim

# Install Chrome dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy package files & install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy build output
COPY --from=build /app/dist ./dist

# Create non-root user
RUN groupadd -r openwa && useradd -r -g openwa openwa
RUN chown -R openwa:openwa /app
USER openwa

# Expose port
EXPOSE 2785

# Health check (global API prefix is 'api'; readiness probes both databases)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
    CMD curl -f http://localhost:2785/api/health/ready || exit 1

# Start app
CMD ["node", "dist/main.js"]
```

### Docker Compose (Development)

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build:
      context: .
      target: build
    command: npm run start:dev
    ports:
      - "2785:2785"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://openwa:openwa@postgres:5432/openwa
      - REDIS_URL=redis://redis:6379
      # The env var is API_MASTER_KEY (not API_KEY_MASTER); never hardcode a key — set a
      # strong secret. Production refuses to boot with a placeholder/default (M9/M16).
      - API_MASTER_KEY=
    volumes:
      - ./:/app
      - /app/node_modules
      - session-data:/app/.wwebjs_auth
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=openwa
      - POSTGRES_PASSWORD=openwa
      - POSTGRES_DB=openwa
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"

  # No separate dashboard service: the `app` image bundles the dashboard SPA and serves it
  # from the same port (2785) via NestJS. Open http://localhost:2785 for the UI.

volumes:
  postgres-data:
  redis-data:
  session-data:
```

### Docker Compose (Production)

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  app:
    image: ghcr.io/rmyndharis/openwa:latest
    deploy:
      replicas: 1
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - API_MASTER_KEY=${API_MASTER_KEY}
    volumes:
      - session-data:/app/.wwebjs_auth
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:2785/api/health/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: always

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - app
    restart: always

volumes:
  session-data:
    driver: local
```

> [!IMPORTANT]
> **Keep `replicas: 1`.** OpenWA is a single-process application: live engine state lives in an
> in-memory `Map` in `SessionService` (`src/modules/session/session.service.ts`). Multi-replica is
> **not** a supported topology — running two replicas against a shared `SESSION_DATA_PATH` makes two
> browsers write the same WhatsApp LocalAuth directory and **corrupts the session** (forced logout /
> ban). Shared storage and sticky sessions do **not** make multi-replica safe. See
> [13 - Horizontal Scaling Guide](./13-horizontal-scaling.md) for the `replicas: 1` stance and the
> (unimplemented) session-claim design that would be required first.

## 10.3 CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linter
        run: npm run lint
      
      - name: Run tests
        run: npm run test:cov
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=sha,prefix=
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
      
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop'
    environment: staging
    
    steps:
      - name: Deploy to Staging
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.STAGING_USER }}
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /opt/openwa
            docker compose pull
            docker compose up -d
            docker system prune -f

  deploy-production:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: production
    
    steps:
      - name: Deploy to Production
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/openwa
            docker compose -f docker-compose.prod.yml pull
            docker compose -f docker-compose.prod.yml up -d --no-deps app
            docker system prune -f
```

## 10.4 Deployment Architecture

### Single Server Deployment

```mermaid
flowchart TB
    subgraph Server["Single Server"]
        NGINX[Nginx Reverse Proxy]
        NGINX --> APP[OpenWA App]
        APP --> PG[(PostgreSQL)]
        APP --> RD[(Redis)]
        APP --> FS[File Storage]
    end
    
    Internet --> NGINX
```

### Multi-Server Deployment

> **Design sketch, not a supported topology.** OpenWA is single-process with in-memory engine state,
> so the multi-`OpenWA` fan-out below would corrupt WhatsApp auth across replicas. It is retained only
> as the target architecture once the session-claim design in
> [13 - Horizontal Scaling Guide](./13-horizontal-scaling.md) is implemented. Deploy with `replicas: 1`.

```mermaid
flowchart TB
    subgraph External["External"]
        CDN[CDN / CloudFlare]
    end
    
    subgraph LoadBalancer["Load Balancer"]
        LB[HAProxy / Nginx]
    end
    
    subgraph AppServers["Application Servers"]
        APP1[OpenWA 1]
        APP2[OpenWA 2]
        APP3[OpenWA N]
    end
    
    subgraph DataLayer["Data Layer"]
        PG[(PostgreSQL Primary)]
        PGR[(PostgreSQL Replica)]
        RD[(Redis Cluster)]
        S3[(S3 Storage)]
    end
    
    CDN --> LB
    LB --> APP1 & APP2 & APP3
    APP1 & APP2 & APP3 --> PG
    APP1 & APP2 & APP3 --> RD
    APP1 & APP2 & APP3 --> S3
    PG --> PGR
```

## 10.5 Environment Configuration

### Environment Variables

```bash
# .env.example

# ===========================================
# APPLICATION
# ===========================================
NODE_ENV=production
PORT=2785
API_PREFIX=/api
LOG_LEVEL=info
LOG_FORMAT=json

# ===========================================
# DATABASE (choose one)
# ===========================================
# Option 1: SQLite (for minimal deployments)
DATABASE_TYPE=sqlite
DATABASE_SQLITE_PATH=./data/openwa.db

# Option 2: PostgreSQL (for production)
# DATABASE_TYPE=postgres
# DATABASE_URL=postgresql://user:pass@localhost:5432/openwa
# DATABASE_POOL_MAX=20
# DATABASE_SSL=false

# ===========================================
# MEDIA STORAGE (choose one)
# ===========================================
# Option 1: Local filesystem (default)
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=./media
STORAGE_LOCAL_BASE_URL=/media

# Option 2: S3
# STORAGE_TYPE=s3
# STORAGE_S3_BUCKET=openwa-media
# STORAGE_S3_REGION=ap-southeast-1
# STORAGE_S3_ACCESS_KEY_ID=your-access-key
# STORAGE_S3_SECRET_ACCESS_KEY=your-secret-key

# Option 3: MinIO (S3-compatible)
# STORAGE_TYPE=minio
# STORAGE_S3_BUCKET=openwa-media
# STORAGE_S3_ENDPOINT=http://minio:9000
# STORAGE_S3_ACCESS_KEY_ID=minioadmin
# STORAGE_S3_SECRET_ACCESS_KEY=minioadmin
# STORAGE_S3_FORCE_PATH_STYLE=true

# ===========================================
# CACHE & QUEUE (choose one)
# ===========================================
# Option 1: In-Memory (for single instance)
CACHE_TYPE=memory
CACHE_TTL=300
CACHE_MAX=1000

# Option 2: Redis (for multi-instance / production)
# CACHE_TYPE=redis
# REDIS_URL=redis://localhost:6379

# ===========================================
# WHATSAPP ENGINE
# ===========================================
ENGINE_TYPE=whatsapp-web.js
# ENGINE_TYPE=baileys
# ENGINE_TYPE=baileys   # whatsapp-web.js (default) | baileys; omit to use the dashboard selection

# Session
SESSION_DATA_PATH=./.wwebjs_auth

# Puppeteer (for whatsapp-web.js)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_HEADLESS=true
PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox

# ===========================================
# SECURITY
# ===========================================
# Generate with: openssl rand -base64 32
API_MASTER_KEY=your-master-api-key
# Optional HMAC pepper so a DB leak alone can't precompute key hashes
API_KEY_PEPPER=optional-key-hashing-pepper

# ===========================================
# WEBHOOK
# ===========================================
WEBHOOK_TIMEOUT=30000
WEBHOOK_RETRY_COUNT=3
WEBHOOK_RETRY_DELAY=5000

# ===========================================
# RATE LIMITING
# ===========================================
# Three global per-IP windows (short/medium/long); defaults shown
RATE_LIMIT_MEDIUM_TTL=60000
RATE_LIMIT_MEDIUM_LIMIT=100
```

### Configuration Service

```typescript
// config/configuration.ts
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  security: {
    masterApiKey: process.env.API_MASTER_KEY,
  },
  session: {
    dataPath: process.env.SESSION_DATA_PATH || './.wwebjs_auth',
  },
  webhook: {
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT, 10) || 30000,
    retryCount: parseInt(process.env.WEBHOOK_RETRY_COUNT, 10) || 3,
    retryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY, 10) || 5000,
  },
  rateLimit: {
    shortTtl: parseInt(process.env.RATE_LIMIT_SHORT_TTL, 10) || 1000,
    shortLimit: parseInt(process.env.RATE_LIMIT_SHORT_LIMIT, 10) || 10,
    mediumTtl: parseInt(process.env.RATE_LIMIT_MEDIUM_TTL, 10) || 60000,
    mediumLimit: parseInt(process.env.RATE_LIMIT_MEDIUM_LIMIT, 10) || 100,
    longTtl: parseInt(process.env.RATE_LIMIT_LONG_TTL, 10) || 3600000,
    longLimit: parseInt(process.env.RATE_LIMIT_LONG_LIMIT, 10) || 1000,
  },
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args: process.env.PUPPETEER_ARGS?.split(',') || [],
  },
});
```

## 10.6 Monitoring & Observability

### Monitoring Stack

```mermaid
flowchart LR
    subgraph App["Application"]
        METRICS[Metrics Endpoint]
        LOGS[Structured Logs]
        TRACES[Traces]
    end
    
    subgraph Collection["Collection"]
        PROM[Prometheus]
        LOKI[Loki]
        TEMPO[Tempo]
    end
    
    subgraph Visualization["Visualization"]
        GRAF[Grafana]
    end
    
    subgraph Alerting["Alerting"]
        AM[AlertManager]
        SLACK[Slack]
        EMAIL[Email]
    end
    
    METRICS --> PROM --> GRAF
    LOGS --> LOKI --> GRAF
    TRACES --> TEMPO --> GRAF
    PROM --> AM
    AM --> SLACK & EMAIL
```

### Docker Compose Monitoring Stack

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.47.0
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./monitoring/alerts.yml:/etc/prometheus/alerts.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=30d'
    ports:
      - "9090:9090"
    restart: unless-stopped

  grafana:
    image: grafana/grafana:10.1.0
    volumes:
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning
      - ./monitoring/grafana/dashboards:/var/lib/grafana/dashboards
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
      - GF_USERS_ALLOW_SIGN_UP=false
    ports:
      - "3001:3000"
    depends_on:
      - prometheus
      - loki
    restart: unless-stopped

  loki:
    image: grafana/loki:2.9.0
    volumes:
      - ./monitoring/loki.yml:/etc/loki/local-config.yaml
      - loki-data:/loki
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "3100:3100"
    restart: unless-stopped

  promtail:
    image: grafana/promtail:2.9.0
    volumes:
      - ./monitoring/promtail.yml:/etc/promtail/config.yml
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    command: -config.file=/etc/promtail/config.yml
    depends_on:
      - loki
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:v0.26.0
    volumes:
      - ./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml
    ports:
      - "9093:9093"
    restart: unless-stopped

  node-exporter:
    image: prom/node-exporter:v1.6.1
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
    ports:
      - "9100:9100"
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
  loki-data:
```

### Prometheus Configuration

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - 'alerts.yml'

scrape_configs:
  - job_name: 'openwa'
    static_configs:
      - targets: ['app:2785']
    metrics_path: '/api/metrics'

  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

### Alert Rules

These rules use the metric names OpenWA actually exports (`openwa_*`). The memory rule below uses a
node-exporter metric — an **external** exporter, not the app — and is kept as a host-level example.

```yaml
# monitoring/alerts.yml
groups:
  - name: openwa-alerts
    rules:
      # Service Down — openwa_up disappears (or the scrape fails)
      - alert: ServiceDown
        expr: up{job="openwa"} == 0 or absent(openwa_up)
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "OpenWA service is down"
          description: "The OpenWA application is not responding"

      # Session(s) disconnected
      - alert: SessionDisconnected
        expr: openwa_sessions{status="disconnected"} > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "WhatsApp session disconnected"
          description: "{{ $value }} session(s) in disconnected state"

      # Failed messages climbing
      - alert: FailedMessagesRising
        expr: rate(openwa_messages_failed_total[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Messages are failing"
          description: "openwa_messages_failed_total is increasing over the last 5 minutes"

      # Process memory growth (app-exported RSS; ~2GB example threshold)
      - alert: HighProcessMemory
        expr: openwa_process_resident_memory_bytes > 2e9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High OpenWA process memory"
          description: "RSS is {{ $value | humanize1024 }}B"

      # Host memory pressure — EXTERNAL (node-exporter), not exported by OpenWA
      - alert: HighHostMemoryUsage
        expr: |
          (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)
          / node_memory_MemTotal_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High host memory usage"
          description: "Host memory usage is {{ $value | humanizePercentage }}"
```

### AlertManager Configuration

```yaml
# monitoring/alertmanager.yml
global:
  resolve_timeout: 5m
  slack_api_url: '${SLACK_WEBHOOK_URL}'

route:
  group_by: ['alertname', 'severity']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'slack-notifications'
  routes:
    - match:
        severity: critical
      receiver: 'slack-critical'
    - match:
        severity: warning
      receiver: 'slack-warnings'

receivers:
  - name: 'slack-notifications'
    slack_configs:
      - channel: '#openwa-alerts'
        send_resolved: true

  - name: 'slack-critical'
    slack_configs:
      - channel: '#openwa-critical'
        send_resolved: true
        title: '🚨 CRITICAL: {{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

  - name: 'slack-warnings'
    slack_configs:
      - channel: '#openwa-alerts'
        send_resolved: true
        title: '⚠️ WARNING: {{ .GroupLabels.alertname }}'
```

### Health Check Endpoint

All health endpoints are `@Public()` (no API key) and `@SkipThrottle()`, and live under the global
`api` prefix. There is **no** `/health/detailed` endpoint.

| Endpoint | Purpose | Body | Codes |
|----------|---------|------|-------|
| `GET /api/health` | Basic check | `{ status, timestamp, version }` (version from `package.json`) | 200 |
| `GET /api/health/live` | Liveness (deliberately static — a transient dependency outage must not KILL the pod) | `{ status: 'ok' }` | 200 |
| `GET /api/health/ready` | Readiness — probes **both** databases (`main` + `data`, `SELECT 1`, 3s timeout each) and reports 503 while draining (graceful shutdown) | `{ status, details: { mainDatabase, dataDatabase } }` | 200 / 503 |

```typescript
// health/health.controller.ts
@Controller('health')
@Public()       // no API key required
@SkipThrottle()
export class HealthController {
  @Get()
  check(): { status: string; timestamp: string; version: string } {
    return { status: 'ok', timestamp: new Date().toISOString(), version: APP_VERSION };
  }

  @Get('live')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<HealthCheckResult> {
    // 503 while draining so the LB stops routing before teardown.
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({ status: 'error', details: { shutdown: { status: 'draining' } } });
    }
    const [main, data] = await Promise.all([
      this.probeDatabase(this.mainDataSource),
      this.probeDatabase(this.dataDataSource),
    ]);
    const details = { mainDatabase: { status: main }, dataDatabase: { status: data } };
    if (main === 'down' || data === 'down') {
      throw new ServiceUnavailableException({ status: 'error', details });
    }
    return { status: 'ok', details };
  }
}
```

### Prometheus Metrics Implementation

The metrics surface is small, so OpenWA emits Prometheus text exposition format (v0.0.4) **by hand** —
there is **no `prom-client` dependency** and **no `collectDefaultMetrics`**. `MetricsService` reads an
aggregate overview from `StatsService` plus `process.memoryUsage()`, memoizes the rendered text for a
short TTL (~5s, so back-to-back scrapes don't repeat the DB scan), and exposes it at
`GET /api/metrics`.

Access is **disabled by default**: the endpoint returns **404** unless `METRICS_TOKEN` is set. When
set, scrapers must send `Authorization: Bearer <token>` (compared with `timingSafeEqual`); a missing or
wrong token returns 401. The token is **separate** from the API key — the route is `@Public()` (skips
the API-key guard) and `@SkipThrottle()`.

```typescript
// metrics/metrics.service.ts (dependency-free; emits text v0.0.4 by hand)
@Injectable()
export class MetricsService {
  constructor(
    private readonly config: ConfigService,
    private readonly statsService: StatsService,
  ) {}

  async render(): Promise<string> {
    const overview = await this.statsService.getOverview();
    const mem = process.memoryUsage();
    const lines: string[] = [];
    // ... gauge() helper pushes `# HELP` / `# TYPE` / value lines ...
    gauge('openwa_up', '...', 1);
    gauge('openwa_process_uptime_seconds', '...', Math.round(process.uptime()));
    gauge('openwa_process_resident_memory_bytes', '...', mem.rss);
    gauge('openwa_process_heap_used_bytes', '...', mem.heapUsed);
    gauge('openwa_sessions_total', '...', overview.sessions.total);
    gauge('openwa_sessions_active', '...', overview.sessions.active);
    // openwa_sessions{status="..."} — one line per status
    // openwa_messages_total{direction="outgoing"|"incoming"}
    // openwa_messages_failed_total
    return lines.join('\n') + '\n';
  }
}
```

**Exported metric names** (the complete set — nothing else is emitted):

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `openwa_up` | gauge | — | Always `1` when scraped |
| `openwa_process_uptime_seconds` | gauge | — | Process uptime |
| `openwa_process_resident_memory_bytes` | gauge | — | RSS |
| `openwa_process_heap_used_bytes` | gauge | — | V8 heap used |
| `openwa_sessions_total` | gauge | — | Configured sessions |
| `openwa_sessions_active` | gauge | — | READY (active) sessions |
| `openwa_sessions` | gauge | `status` | Session count per status |
| `openwa_messages_total` | counter | `direction` (`incoming`/`outgoing`) | Messages by direction |
| `openwa_messages_failed_total` | counter | — | Messages in FAILED state |

### Grafana Dashboard Definition

```json
// monitoring/grafana/dashboards/openwa.json — panels use the openwa_* metrics OpenWA exports
{
  "title": "OpenWA Dashboard",
  "uid": "openwa-main",
  "panels": [
    {
      "title": "Active Sessions",
      "type": "stat",
      "gridPos": { "x": 0, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "openwa_sessions_active" }
      ]
    },
    {
      "title": "Messages Sent (24h)",
      "type": "stat",
      "gridPos": { "x": 6, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "increase(openwa_messages_total{direction=\"outgoing\"}[24h])" }
      ]
    },
    {
      "title": "Failed Messages",
      "type": "stat",
      "gridPos": { "x": 12, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "openwa_messages_failed_total" }
      ]
    },
    {
      "title": "Sessions by Status",
      "type": "timeseries",
      "gridPos": { "x": 0, "y": 4, "w": 12, "h": 8 },
      "targets": [
        { "expr": "openwa_sessions", "legendFormat": "{{status}}" }
      ]
    },
    {
      "title": "Message Rate by Direction",
      "type": "timeseries",
      "gridPos": { "x": 12, "y": 4, "w": 12, "h": 8 },
      "targets": [
        { "expr": "rate(openwa_messages_total[5m])", "legendFormat": "{{direction}}" }
      ]
    },
    {
      "title": "Process Memory",
      "type": "timeseries",
      "gridPos": { "x": 0, "y": 12, "w": 12, "h": 8 },
      "targets": [
        { "expr": "openwa_process_resident_memory_bytes / 1024 / 1024", "legendFormat": "RSS (MB)" },
        { "expr": "openwa_process_heap_used_bytes / 1024 / 1024", "legendFormat": "Heap used (MB)" }
      ]
    },
    {
      "title": "Uptime",
      "type": "stat",
      "gridPos": { "x": 12, "y": 12, "w": 12, "h": 8 },
      "targets": [
        { "expr": "openwa_process_uptime_seconds" }
      ]
    }
  ]
}
```

### Structured Logging

```typescript
// common/logging/logger.service.ts
import { Injectable, LoggerService } from '@nestjs/common';
import * as winston from 'winston';

@Injectable()
export class AppLoggerService implements LoggerService {
  private logger: winston.Logger;

  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      defaultMeta: { 
        service: 'openwa',
        version: process.env.npm_package_version 
      },
      transports: [
        new winston.transports.Console(),
        // For Loki
        new winston.transports.Http({
          host: process.env.LOKI_HOST || 'loki',
          port: 3100,
          path: '/loki/api/v1/push',
        }),
      ],
    });
  }

  log(message: string, context?: object) {
    this.logger.info(message, { context });
  }

  error(message: string, trace?: string, context?: object) {
    this.logger.error(message, { trace, context });
  }

  warn(message: string, context?: object) {
    this.logger.warn(message, { context });
  }

  debug(message: string, context?: object) {
    this.logger.debug(message, { context });
  }
}

// Usage example
this.logger.log('Message sent', {
  sessionId: 'sess_123',
  chatId: '628xxx@c.us',
  messageType: 'text',
  duration: 1.5
});
```

### Key Metrics to Monitor

These are the metrics OpenWA actually exports at `GET /api/metrics`:

| Category | Metric | Description | Alert Idea |
|----------|--------|-------------|------------|
| **Liveness** | `openwa_up` | Always `1` when scraped (absence/scrape-failure = down) | Target down |
| **Sessions** | `openwa_sessions_total` | Configured sessions | Near your expected session count |
| **Sessions** | `openwa_sessions_active` | READY (active) sessions | Drops below expected |
| **Sessions** | `openwa_sessions{status="..."}` | Per-status counts (e.g. `disconnected`, `failed`) | `disconnected`/`failed` > 0 |
| **Messages** | `openwa_messages_total{direction="outgoing"}` | Outgoing messages | Sudden drop |
| **Messages** | `openwa_messages_total{direction="incoming"}` | Incoming messages | Sudden drop |
| **Messages** | `openwa_messages_failed_total` | Messages in FAILED state | Rising rate |
| **System** | `openwa_process_resident_memory_bytes` | RSS | Growth / near limit |
| **System** | `openwa_process_heap_used_bytes` | V8 heap used | Growth |
| **System** | `openwa_process_uptime_seconds` | Process uptime | Frequent restarts (resets) |

> OpenWA does **not** expose request-rate, latency-histogram, webhook, queue, or Node default
> (`nodejs_*`) metrics. For host/container-level signals (CPU, memory pressure, event-loop), scrape
> external exporters: `up` and `container_memory_usage_bytes` come from blackbox/cAdvisor, and
> `node_*` from node-exporter — not from the app.


## 10.7 Backup & Recovery

### Backup Strategy

```mermaid
flowchart TB
    subgraph Daily["Daily Backup"]
        DB[(Database)] --> DUMP[pg_dump]
        DUMP --> COMPRESS[gzip]
        COMPRESS --> ENCRYPT[encrypt]
        ENCRYPT --> S3[S3 Storage]
    end
    
    subgraph Retention["Retention Policy"]
        D7[Daily: 7 days]
        W4[Weekly: 4 weeks]
        M12[Monthly: 12 months]
    end
```

### Backup Script

```bash
#!/bin/bash
# scripts/backup.sh

set -e

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"
S3_BUCKET="s3://openwa-backups"

# Database backup
echo "Backing up database..."
pg_dump -Fc $DATABASE_URL > $BACKUP_DIR/db_$DATE.dump
gzip $BACKUP_DIR/db_$DATE.dump

# Session data backup
echo "Backing up session data..."
tar -czf $BACKUP_DIR/sessions_$DATE.tar.gz /app/.wwebjs_auth

# Upload to S3
echo "Uploading to S3..."
aws s3 cp $BACKUP_DIR/db_$DATE.dump.gz $S3_BUCKET/database/
aws s3 cp $BACKUP_DIR/sessions_$DATE.tar.gz $S3_BUCKET/sessions/

# Cleanup local files older than 7 days
find $BACKUP_DIR -mtime +7 -delete

echo "Backup completed: $DATE"
```

### Recovery Procedure

```bash
#!/bin/bash
# scripts/restore.sh

set -e

BACKUP_DATE=$1

# Download from S3
aws s3 cp s3://openwa-backups/database/db_$BACKUP_DATE.dump.gz /tmp/
aws s3 cp s3://openwa-backups/sessions/sessions_$BACKUP_DATE.tar.gz /tmp/

# Restore database
gunzip /tmp/db_$BACKUP_DATE.dump.gz
pg_restore -d $DATABASE_URL /tmp/db_$BACKUP_DATE.dump

# Restore sessions
tar -xzf /tmp/sessions_$BACKUP_DATE.tar.gz -C /

echo "Restore completed"
```

## 10.8 Scaling Guidelines

### Vertical Scaling

OpenWA scales **vertically** — add CPU/RAM to a single instance. The table below is **unbenchmarked
starting guidance**, not measured figures; actual usage depends heavily on engine choice
(whatsapp-web.js spawns a Chromium per session; Baileys is far lighter), message volume, and media.
Size up from your own monitoring.

| Sessions | RAM | CPU | Storage |
|----------|-----|-----|---------|
| 1-5 | 2GB | 2 cores | 20GB |
| 5-10 | 4GB | 4 cores | 50GB |
| 10-20 | 8GB | 8 cores | 100GB |
| 20+ | 16GB+ | 16+ cores | 200GB+ |

### Horizontal Scaling

**Not currently supported.** OpenWA is a single-process application with in-memory engine state, so
multiple replicas against a shared session volume corrupt WhatsApp auth. Run exactly **one** API
instance per session-data volume (`replicas: 1`). The DB-backed session registry / node-claim design
that would be required to scale out is documented — as a future design sketch, not a shipped feature —
in [13 - Horizontal Scaling Guide](./13-horizontal-scaling.md).
---

<div align="center">

[← 09 - Testing Strategy](./09-testing-strategy.md) · [Documentation Index](./README.md) · [Next: 11 - Operational Runbooks →](./11-operational-runbooks.md)

</div>
