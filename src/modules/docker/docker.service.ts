import { Injectable, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import Docker from 'dockerode';
import { isEnvPinned, isOsProvidedEnv } from '../../config/env-precedence';
import { readGeneratedEnv } from '../infra/generated-env';
import { BUNDLED_SERVICE_ENV, namesBundledContainer } from './bundled-host';

/**
 * The only Docker profiles OpenWA manages (and may start/stop). Used to bound teardown so a
 * caller-supplied profile name can never reach stopManagedService for an unrelated container.
 */
export const MANAGED_DOCKER_PROFILES: readonly string[] = ['postgres', 'redis', 'minio'];

/**
 * Whether the configuration `read` describes uses the datastore a managed profile runs. Redis is reached by the
 * queue and the cache as well as by REDIS_ENABLED, each of which connects on its own.
 */
export function datastoreInUse(profile: string, read: (key: string) => string | undefined): boolean {
  if (profile === 'postgres') return read('DATABASE_TYPE') === 'postgres';
  if (profile === 'minio') return read('STORAGE_TYPE') === 's3';
  return ['REDIS_ENABLED', 'QUEUE_ENABLED', 'CACHE_ENABLED'].some(key => read(key) === 'true');
}

/**
 * Whether the environment (or the project .env) pins the profile's host to anything but its bundled container, in
 * any spelling namesBundledContainer accepts. The pin outranks the saved file at every boot, so a container started
 * for that profile would run with nothing using it.
 */
export function hostPinnedElsewhere(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const [key] = BUNDLED_SERVICE_ENV[profile] ?? [];
  return key !== undefined && isEnvPinned(key) && !namesBundledContainer(profile, env[key]);
}

interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  labels: Record<string, string>;
}

interface OrchestrationResult {
  success: boolean;
  message: string;
  containersStarted: string[];
  containersStopped: string[];
  errors: string[];
  estimatedTime: number; // Estimated restart time in seconds
}

/** How long a reachability or listing call may take before the daemon is read as unavailable. */
const DOCKER_CALL_TIMEOUT_MS = 10_000;

@Injectable()
export class DockerService implements OnModuleInit {
  private readonly logger = createLogger(DockerService.name);
  private docker: Docker | null = null;
  private isAvailable = false;
  /** Whether a daemon has ever answered, so a later loss is a reconnect and not a deployment without Docker. */
  private hasConnected = false;
  private reinitInFlight = false;
  /** Visible for testing. */
  callTimeoutMs = DOCKER_CALL_TIMEOUT_MS;

  /**
   * dockerode sets no timeout, so a daemon or socket proxy that accepts the connection and never
   * answers (a dropped SYN, a wedged upstream) would hold the caller, boot included, until the OS or
   * the proxy gave up. Short calls are bounded here; image pulls and container starts are not.
   *
   * The call is aborted when the deadline passes, not only raced: a call left running keeps its request
   * and its socket open, and every later availability check would add one more.
   */
  private async answered<T>(call: (signal: AbortSignal) => Promise<T>, what: string): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Docker did not answer ${what} within ${this.callTimeoutMs}ms`));
        controller.abort();
      }, this.callTimeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * dockerode's runtime takes an options object with `abortSignal` on every call, which its typings
   * declare only for some of them.
   */
  private abortable<T>(method: 'ping', abortSignal: AbortSignal): Promise<T> {
    const call = this.docker![method].bind(this.docker) as unknown as (options: {
      abortSignal: AbortSignal;
    }) => Promise<T>;
    return call({ abortSignal });
  }

  async onModuleInit() {
    await this.initializeDocker();
    // Bootstrap orchestration: start containers based on saved config
    await this.bootstrapOrchestration();
  }

  /**
   * Bootstrap orchestration: start built-in containers based on saved config.
   * Runs from onModuleInit, which Nest calls only after the data connection is up. When that
   * connection is the built-in database (DATABASE_TYPE=postgres), the postgres profile is a no-op
   * here: a stopped container was already started by prestartBuiltinDatabase in main.ts. A flag set
   * for a datastore this boot does not use (see datastoreInUse), or whose host the environment pins
   * elsewhere, starts nothing.
   */
  private async bootstrapOrchestration(): Promise<void> {
    if (!this.isAvailable) {
      this.logger.log('[Bootstrap Orchestration] Docker not available, skipping');
      return;
    }

    const env = (key: string): string | undefined => process.env[key];
    const wanted = (profile: string, flag: string | undefined): boolean =>
      flag === 'true' && datastoreInUse(profile, env) && !hostPinnedElsewhere(profile);

    // Check for built-in services from environment variables
    const profiles = [
      wanted('redis', process.env.REDIS_BUILTIN) && 'redis',
      wanted('postgres', process.env.POSTGRES_BUILTIN) && 'postgres',
      wanted('minio', process.env.MINIO_BUILTIN) && 'minio',
    ].filter((p): p is string => typeof p === 'string');

    if (profiles.length === 0) {
      this.logger.log('[Bootstrap Orchestration] No built-in services configured');
      return;
    }

    this.logger.log(`[Bootstrap Orchestration] Starting built-in services: ${profiles.join(', ')}`);
    const result = await this.orchestrateProfiles(profiles);

    if (result.success) {
      this.logger.log(`[Bootstrap Orchestration] Started ${result.containersStarted.length} container(s)`);
    } else {
      this.logger.warn(`[Bootstrap Orchestration] Issues: ${result.errors.join('; ')}`);
    }
  }

  /** Start the built-in PostgreSQL container, creating it if absent. Never throws. */
  async startBuiltinDatabase(): Promise<void> {
    await this.initializeDocker();
    if (this.isAvailable) await this.startService('database');
  }

  private async initializeDocker(): Promise<void> {
    try {
      this.docker = new Docker(this.buildDockerOptions());
      await this.answered(abortSignal => this.abortable<unknown>('ping', abortSignal), 'a ping');
      this.isAvailable = true;
      this.hasConnected = true;
      this.logger.log('Docker API connected successfully');
    } catch (error) {
      this.logger.warn('Docker not available. Container orchestration disabled.', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isAvailable = false;
    }
  }

  // Visible for testing
  buildDockerOptions(): Docker.DockerOptions {
    const dockerHost = process.env.DOCKER_HOST;
    if (dockerHost) {
      const match = /^tcp:\/\/([^:]+):(\d+)$/.exec(dockerHost);
      if (match) {
        return { host: match[1], port: parseInt(match[2], 10), protocol: 'http' };
      }
    }
    return { socketPath: '/var/run/docker.sock' };
  }

  /**
   * Check if Docker is available.
   *
   * Startup-race recovery: when the API talks to the Docker socket-proxy over TCP
   * (DOCKER_HOST=tcp://...), the proxy container may not be accepting connections at
   * the moment onModuleInit runs (compose `service_started` doesn't wait for readiness).
   * If the first connect failed, retry it once in the background here so orchestration
   * recovers without a process restart. Only for the DOCKER_HOST (proxy/tcp) case or a daemon
   * that answered before: a docker-less deployment has no such race. Built-in services the boot
   * skipped while Docker was unreachable are started once it answers.
   */
  isDockerAvailable(): boolean {
    if (!this.isAvailable && !this.reinitInFlight && (process.env.DOCKER_HOST || this.hasConnected)) {
      this.reinitInFlight = true;
      void this.initializeDocker()
        .then(() => this.bootstrapOrchestration())
        .catch(error => this.logger.warn('Could not start built-in services after Docker recovery', String(error)))
        .finally(() => {
          this.reinitInFlight = false;
        });
    }
    return this.isAvailable;
  }

  /**
   * List all OpenWA-related containers, or null when the daemon could not be asked: an empty list
   * means it was asked and none exist, which callers act on.
   */
  async listContainers(): Promise<ContainerInfo[] | null> {
    if (!this.docker || !this.isAvailable) {
      return null;
    }

    try {
      const containers = await this.answered(
        abortSignal => this.docker!.listContainers({ all: true, abortSignal }),
        'a container list',
      );
      return containers
        .filter(c => {
          // Filter by OpenWA labels or name prefix
          const labels = c.Labels || {};
          return labels['com.openwa.service'] || c.Names?.some(n => n.startsWith('/openwa-'));
        })
        .map(c => ({
          id: c.Id.substring(0, 12),
          name: c.Names?.[0]?.replace(/^\//, '') || 'unknown',
          state: c.State || 'unknown',
          status: c.Status || 'unknown',
          labels: c.Labels || {},
        }));
    } catch (error) {
      this.logger.error('Failed to list containers', error);
      this.isAvailable = false;
      return null;
    }
  }

  /**
   * Which bundled (OpenWA-managed) service containers are currently RUNNING, keyed by the
   * `com.openwa.service` label (`database` | `cache` | `storage`), and who created each: `'compose'` for one
   * Docker Compose created (it carries Compose's project label and belongs to the deployment), `'openwa'` for
   * one createService made. Lets the dashboard show the real built-in state instead of the saved intent. All
   * false when none run; null when Docker could not be observed.
   */
  async getRunningBuiltinServices(): Promise<Record<
    'database' | 'cache' | 'storage',
    false | 'compose' | 'openwa'
  > | null> {
    const containers = await this.listContainers();
    if (containers === null) return null;
    const creator = (svc: string): false | 'compose' | 'openwa' => {
      const running = containers.find(
        c =>
          c.labels['com.openwa.service'] === svc && c.labels['com.openwa.builtin'] === 'true' && c.state === 'running',
      );
      if (!running) return false;
      return running.labels['com.docker.compose.project'] ? 'compose' : 'openwa';
    };
    return { database: creator('database'), cache: creator('cache'), storage: creator('storage') };
  }

  /**
   * Get container by service name or label
   */
  async getContainerByService(service: string): Promise<Docker.Container | null> {
    if (!this.docker || !this.isAvailable) {
      return null;
    }

    try {
      const containers = await this.answered(
        abortSignal =>
          this.docker!.listContainers({
            all: true,
            filters: {
              label: [`com.openwa.service=${service}`],
            },
            abortSignal,
          }),
        'a container list',
      );

      if (containers.length > 0) {
        return this.docker.getContainer(containers[0].Id);
      }

      // Fallback: try by EXACT name (never a substring — a substring, and especially the empty
      // string, would resolve an arbitrary container). OpenWA-managed containers are `openwa-<service>`.
      const target = `openwa-${service}`;
      const allContainers = await this.answered(
        abortSignal => this.docker!.listContainers({ all: true, abortSignal }),
        'a container list',
      );
      const match = allContainers.find(c => c.Names?.some(n => n === target || n === `/${target}`));

      if (match) {
        return this.docker.getContainer(match.Id);
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to get container for service: ${service}`, error);
      return null;
    }
  }

  /**
   * Container specifications for the three managed profiles, kept in parity with the matching
   * services in docker-compose.yml (same image pin, container/volume/network names, command,
   * healthcheck, labels, restart policy, no-new-privileges). compose-parity.spec.ts is the
   * regression lock: it reads docker-compose.yml and fails when either side drifts.
   *
   * Deliberate differences from the compose services — do not "fix" these:
   *  - Credentials: the compose services are the MANUAL operator path and deliberately ship no
   *    default secret (an empty POSTGRES_PASSWORD fails when the volume is first initialized; a
   *    MINIO_ROOT_PASSWORD left on its sub-minimum placeholder fails at every start). The specs below
   *    are the dashboard built-in path: they provision the built-in credentials, by default
   *    (openwa/openwa, minioadmin/minioadmin), that infra-config.controller writes to data/.env.generated
   *    and that the production boot guard (bootstrap-security.ts) exempts only while the
   *    *_BUILTIN flag is set AND the datastore host resolves to the internal-only container.
   *  - Postgres init script: compose bind-mounts scripts/postgres-init-schema.sh from the host
   *    checkout to support a custom POSTGRES_SCHEMA. The Docker-API path cannot know a host path
   *    to mount, and the built-in flow always pins POSTGRES_SCHEMA=public, so no init script (or
   *    POSTGRES_SCHEMA env) is set here.
   *  - Host ports: compose's minio (the manual path, operator-set credentials) publishes
   *    127.0.0.1:9000/9001. The specs below publish nothing, like postgres and redis: they run the
   *    fixed built-in credentials, which the boot guard exempts only because the container is
   *    reachable on the internal network alone. The app reaches it by its `minio` alias.
   *  - Resource limits: neither path sets CPU/memory/PID limits on the datastore containers;
   *    only openwa-api carries mem_limit/pids_limit (in compose).
   */
  private getContainerSpec(profile: string): {
    image: string;
    name: string;
    alias: string; // DNS alias for network resolution
    env?: string[];
    cmd?: string[];
    volumes?: { name: string; path: string }[];
    healthcheck?: { test: string[]; interval: number; timeout: number; retries: number };
    labels: Record<string, string>;
    securityOpt: string[];
  } | null {
    // A container outlives the process that creates it, and after a dashboard save the restart that
    // creates it runs in the OLD process, whose env still holds the values the save just replaced.
    // Resolve what the next boot reads instead: a host or project .env value pins, the saved file
    // supplies the rest. With no boot snapshot (unit tests) process.env is the only source there is.
    let saved: Record<string, string> | undefined;
    const nextBoot = (key: string): string | undefined =>
      isEnvPinned(key) || isOsProvidedEnv(key) ? process.env[key] : (saved ??= readGeneratedEnv())[key];
    const specs: Record<string, ReturnType<typeof this.getContainerSpec>> = {
      redis: {
        image: 'redis:7-alpine',
        name: 'openwa-redis',
        alias: 'redis', // DNS alias for resolution
        // noeviction mirrors docker-compose.yml: BullMQ requires it, or Redis may evict queue keys
        // once maxmemory is reached and silently drop queued jobs.
        cmd: ['redis-server', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction'],
        volumes: [{ name: 'openwa_redis-data', path: '/data' }],
        healthcheck: {
          test: ['CMD', 'redis-cli', 'ping'],
          interval: 5000000000, // 5s in nanoseconds
          timeout: 3000000000,
          retries: 5,
        },
        labels: {
          'com.openwa.service': 'cache',
          'com.openwa.builtin': 'true',
        },
        securityOpt: ['no-new-privileges:true'],
      },
      postgres: {
        image: 'postgres:16-alpine',
        name: 'openwa-postgres',
        alias: 'postgres',
        // The built-in credentials — the dashboard saves them to data/.env.generated
        // (infra-config.controller) and the production boot guard exempts the default pair only for the
        // built-in, internal-host deployment (see the getContainerSpec docblock). The password is the
        // one the next boot dials with, like the MinIO keys below: a custom one saved with the built-in
        // database would otherwise never match the role this container initializes, and the app would
        // exit on its first connection.
        env: [
          'POSTGRES_USER=openwa',
          `POSTGRES_PASSWORD=${nextBoot('DATABASE_PASSWORD') || 'openwa'}`,
          'POSTGRES_DB=openwa',
        ],
        volumes: [{ name: 'openwa_postgres-data', path: '/var/lib/postgresql/data' }],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U openwa'],
          interval: 5000000000,
          timeout: 3000000000,
          retries: 5,
        },
        labels: {
          'com.openwa.service': 'database',
          'com.openwa.builtin': 'true',
        },
        securityOpt: ['no-new-privileges:true'],
      },
      minio: {
        // Same pin (release tag and digest) as the compose minio service; never a floating tag.
        image:
          'pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46',
        name: 'openwa-minio',
        alias: 'minio',
        cmd: ['server', '/data', '--console-address', ':9001'],
        env: [
          // Prefer the canonical names the app/dashboard use; fall back to the legacy ones, then the
          // built-in default, so the bundled MinIO and the app share credentials.
          `MINIO_ROOT_USER=${nextBoot('S3_ACCESS_KEY_ID') || nextBoot('S3_ACCESS_KEY') || 'minioadmin'}`,
          `MINIO_ROOT_PASSWORD=${nextBoot('S3_SECRET_ACCESS_KEY') || nextBoot('S3_SECRET_KEY') || 'minioadmin'}`,
        ],
        volumes: [{ name: 'openwa_minio-data', path: '/data' }],
        healthcheck: {
          test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live'],
          interval: 10000000000,
          timeout: 5000000000,
          retries: 3,
        },
        labels: {
          'com.openwa.service': 'storage',
          'com.openwa.builtin': 'true',
        },
        securityOpt: ['no-new-privileges:true'],
      },
    };
    return specs[profile] || null;
  }

  /**
   * Create and start a service using Docker API directly
   */
  async createService(profile: string): Promise<boolean> {
    if (!this.docker || !this.isAvailable) {
      this.logger.error('Docker not available for creating service');
      return false;
    }

    const spec = this.getContainerSpec(profile);
    if (!spec) {
      this.logger.error(`Unknown profile: ${profile}`);
      return false;
    }

    this.logger.log(`Creating service: ${profile} (image: ${spec.image})`);

    try {
      // Check if container already exists
      const existing = await this.getContainerByService(profile);
      if (existing) {
        const info = await this.answered(abortSignal => existing.inspect({ abortSignal }), 'a container inspection');
        this.warnOnImageDrift(profile, spec.name, info);
        if (info.State.Running) {
          this.logger.log(`Container ${spec.name} already running`);
          return true;
        }
        // Start existing container
        await existing.start();
        this.logger.log(`Started existing container: ${spec.name}`);
        return true;
      }

      // Pull only when the image is not already on the host, as compose's default
      // `pull_policy: missing` does: a host that has the image keeps working when the registry is
      // unreachable or has withdrawn it. As with compose, a cached floating tag is not refreshed
      // here. Only an answer that the image is absent pulls: a daemon that fails or does not answer the
      // inspection could not complete a pull either, and the pull itself is not bounded.
      const cached = await this.answered(abortSignal => {
        const image = Object.create(this.docker!.getImage(spec.image)) as Docker.Image;
        const modem = this.docker!.modem;
        // Dockerode 5 leaves the signal out of an image inspection; forward it without changing the shared modem.
        const imageModem = Object.create(modem) as Docker['modem'];
        image.modem = imageModem;
        imageModem.dial = (
          options: Parameters<Docker['modem']['dial']>[0],
          callback: Parameters<Docker['modem']['dial']>[1],
        ) => modem.dial({ ...options, abortSignal }, callback);
        return image.inspect({ abortSignal } as Docker.ImageInspectOptions);
      }, 'an image inspection').then(
        () => true,
        (error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode !== 404) throw error;
          return false;
        },
      );
      if (!cached) {
        this.logger.log(`Pulling image: ${spec.image}`);
        await new Promise<void>((resolve, reject) => {
          void this.docker!.pull(spec.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            this.docker!.modem.followProgress(stream, (err2: Error | null) => {
              if (err2) return reject(err2);
              resolve();
            });
          });
        });
      }

      // Create volume if needed
      if (spec.volumes) {
        for (const vol of spec.volumes) {
          try {
            await this.docker.createVolume({ Name: vol.name });
            this.logger.log(`Created volume: ${vol.name}`);
          } catch (error) {
            this.logger.debug(`Volume ${vol.name} creation skipped (may already exist)`, { error: String(error) });
          }
        }
      }

      // Create container
      const containerConfig: Docker.ContainerCreateOptions = {
        name: spec.name,
        Image: spec.image,
        Cmd: spec.cmd,
        Env: spec.env,
        Labels: spec.labels,
        HostConfig: {
          NetworkMode: 'openwa-network',
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: spec.volumes?.map(v => `${v.name}:${v.path}`),
          SecurityOpt: spec.securityOpt,
        },
        Healthcheck: spec.healthcheck
          ? {
              Test: spec.healthcheck.test,
              Interval: spec.healthcheck.interval,
              Timeout: spec.healthcheck.timeout,
              Retries: spec.healthcheck.retries,
            }
          : undefined,
        NetworkingConfig: {
          EndpointsConfig: {
            'openwa-network': {
              Aliases: [spec.alias, profile], // Add DNS aliases for network resolution
            },
          },
        },
      };

      const container = await this.docker.createContainer(containerConfig);
      await container.start();
      this.logger.log(`Created and started container: ${spec.name}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to create service ${profile}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Start a container by service name - creates if not exists
   */
  async startService(service: string): Promise<boolean> {
    const container = await this.getContainerByService(service);

    // Map service names to docker-compose profiles
    const serviceToProfile: Record<string, string> = {
      database: 'postgres',
      cache: 'redis',
      storage: 'minio',
      postgres: 'postgres',
      redis: 'redis',
      minio: 'minio',
    };
    const profile = serviceToProfile[service] || service;

    if (!container) {
      // Container doesn't exist - create it from the managed spec
      this.logger.log(`Container for service '${service}' not found, creating...`);
      return this.createService(profile);
    }

    try {
      const info = await this.answered(abortSignal => container.inspect({ abortSignal }), 'a container inspection');
      this.warnOnImageDrift(profile, info.Name?.replace(/^\//, '') || service, info);
      if (info.State.Running) {
        this.logger.log(`Service '${service}' is already running`);
        return true;
      }

      await container.start();
      this.logger.log(`Started service: ${service}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to start service: ${service}`, error);
      return false;
    }
  }

  /**
   * A retained container is only ever restarted, never recreated (see stopManagedService), so it
   * keeps the image it was created from after the pin moves. Warn with the way out; start and stop
   * behaviour stay as they are.
   */
  private warnOnImageDrift(profile: string, name: string, info: Docker.ContainerInspectInfo): void {
    const pinned = this.getContainerSpec(profile)?.image;
    const running = info.Config?.Image;
    if (!pinned || !running || running === pinned) return;
    this.logger.warn(
      `Container ${name} runs image ${running}, but this release pins ${pinned}. Remove it with ` +
        `\`docker rm -f ${name}\` (its named data volume is kept) and restart OpenWA or re-enable the ` +
        `service so it is recreated from the pin.` +
        (profile === 'postgres' ? ' A PostgreSQL major version change needs a data migration first.' : ''),
    );
  }

  /**
   * Stop a managed profile's container and RETAIN it for a later re-enable.
   *
   * Deliberately stop-only — no `container.remove()`. The bundled docker-socket-proxy
   * (tecnativa/docker-socket-proxy, pinned v0.5.0) never reads its `DELETE` env flag: its
   * haproxy.cfg method gate is `deny unless METH_GET || env(POST)`, so container deletion is
   * admitted only as an undocumented side effect of POST being enabled — a contract any proxy
   * upgrade may withdraw. Stopping needs nothing beyond POST /containers/{id}/stop, which the
   * orchestration feature already requires, and retention is what the disable→re-enable flow
   * wants anyway: the named data volume and container config survive, and
   * startService()/createService() simply restart the retained container. Stop-only is also
   * strictly less destructive (a remove with `v: true` discards anonymous volumes).
   *
   * Caveat: a retained container keeps its original env, and recreating it applies new credentials
   * only to a service that reads them at every start. MinIO does: after they change, remove the
   * container (`docker rm <name>`) before re-enabling. PostgreSQL does not: POSTGRES_PASSWORD seeds
   * the role only when the data volume is first initialized, so a recreated container still
   * authenticates with the password stored in the volume. Change it with `ALTER ROLE openwa
   * PASSWORD '...'` in the running container, or re-initialize the volume (which discards the data).
   * Redis runs without credentials. To reclaim disk space, remove the container manually.
   */
  async stopManagedService(profile: string): Promise<boolean> {
    this.logger.log(`Stopping service with profile: ${profile} (container retained, not removed)`);

    const serviceMap: Record<string, string> = {
      postgres: 'database',
      redis: 'cache',
      minio: 'storage',
    };

    return this.stopService(serviceMap[profile] || profile);
  }

  /**
   * Stop a container by service name (without removing)
   */
  async stopService(service: string): Promise<boolean> {
    const container = await this.getContainerByService(service);
    if (!container) {
      this.logger.warn(`Container for service '${service}' not found`);
      return true; // Already doesn't exist
    }

    try {
      const info = await this.answered(abortSignal => container.inspect({ abortSignal }), 'a container inspection');
      if (!info.State.Running) {
        this.logger.log(`Service '${service}' is already stopped`);
        return true;
      }

      await container.stop();
      this.logger.log(`Stopped service: ${service}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to stop service: ${service}`, error);
      return false;
    }
  }

  /**
   * Orchestrate services based on required profiles
   * This will start containers that match the profiles
   */
  async orchestrateProfiles(profiles: string[]): Promise<OrchestrationResult> {
    // Calculate estimated time based on profiles
    // Base: 15 seconds for core restart (increased for reliability)
    let estimatedTime = 15;
    if (profiles.includes('postgres')) estimatedTime += 20; // PostgreSQL takes longer
    if (profiles.includes('redis')) estimatedTime += 13;
    if (profiles.includes('minio')) estimatedTime += 15;

    const result: OrchestrationResult = {
      success: true,
      message: '',
      containersStarted: [],
      containersStopped: [],
      errors: [],
      estimatedTime,
    };

    if (!this.docker || !this.isAvailable) {
      result.success = false;
      result.message = 'Docker is not available';
      return result;
    }

    this.logger.log(`Orchestrating profiles: ${profiles.join(', ')}`);

    // Map profiles to service names
    const profileToService: Record<string, string> = {
      postgres: 'database',
      redis: 'cache',
      minio: 'storage',
    };

    for (const profile of profiles) {
      const service = profileToService[profile] || profile;
      try {
        const started = await this.startService(service);
        if (started) {
          result.containersStarted.push(profile);
        } else {
          // startService creates a missing container, so false means the pull, create or start failed.
          result.errors.push(
            `Failed to create or start the '${profile}' container; see the server log for the Docker error.`,
          );
        }
      } catch (error) {
        result.errors.push(`Failed to start ${profile}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (result.errors.length > 0) {
      result.success = profiles.length > 0 && result.containersStarted.length > 0;
      result.message = result.errors.join('; ');
    } else {
      result.message = `Successfully orchestrated ${result.containersStarted.length} service(s)`;
    }

    return result;
  }
}

/**
 * Start the built-in PostgreSQL container before Nest builds the module graph. The data connection
 * dials the database while providers are instantiated, before any onModuleInit runs, so a stopped
 * openwa-postgres would otherwise fail every boot before DockerService could start it. Bounded
 * because dockerode sets no connect timeout; never throws, so on any failure boot proceeds as it
 * would without it and the data connection's retries decide.
 */
export async function prestartBuiltinDatabase(
  env: NodeJS.ProcessEnv = process.env,
  service: Pick<DockerService, 'startBuiltinDatabase'> = new DockerService(),
  timeoutMs = 15_000,
): Promise<void> {
  if (env.DATABASE_TYPE !== 'postgres' || env.POSTGRES_BUILTIN !== 'true' || hostPinnedElsewhere('postgres', env))
    return;
  const logger = createLogger('DockerService');
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      logger.warn(`Built-in PostgreSQL start did not finish within ${timeoutMs}ms; continuing boot`);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([service.startBuiltinDatabase(), deadline]);
  } catch (error) {
    logger.warn(`Could not start built-in PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
