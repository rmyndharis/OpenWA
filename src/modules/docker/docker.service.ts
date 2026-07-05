import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Docker from 'dockerode';

/**
 * The only Docker profiles OpenWA manages (and may start/stop/remove). Used to bound teardown so a
 * caller-supplied profile name can never reach removeService for an unrelated container.
 */
export const MANAGED_DOCKER_PROFILES: readonly string[] = ['postgres', 'redis', 'minio'];

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
  containersRemoved: string[];
  errors: string[];
  estimatedTime: number; // Estimated restart time in seconds
}

@Injectable()
export class DockerService implements OnModuleInit {
  private readonly logger = new Logger(DockerService.name);
  private docker: Docker | null = null;
  private isAvailable = false;
  private reinitInFlight = false;

  async onModuleInit() {
    await this.initializeDocker();
    // Bootstrap orchestration: start containers based on saved config
    await this.bootstrapOrchestration();
  }

  /**
   * Bootstrap orchestration: start built-in containers based on saved config
   * This runs on application startup to ensure containers match saved configuration
   */
  private async bootstrapOrchestration(): Promise<void> {
    if (!this.isAvailable) {
      this.logger.log('[Bootstrap Orchestration] Docker not available, skipping');
      return;
    }

    const profiles: string[] = [];

    // Check for built-in services from environment variables
    if (process.env.REDIS_BUILTIN === 'true') {
      profiles.push('redis');
    }
    if (process.env.POSTGRES_BUILTIN === 'true') {
      profiles.push('postgres');
    }
    if (process.env.MINIO_BUILTIN === 'true') {
      profiles.push('minio');
    }

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

  private async initializeDocker(): Promise<void> {
    try {
      this.docker = new Docker(this.buildDockerOptions());
      await this.docker.ping();
      this.isAvailable = true;
      this.logger.log('Docker API connected successfully');
    } catch (error) {
      this.logger.warn(
        'Docker not available. Container orchestration disabled.',
        error instanceof Error ? error.message : error,
      );
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
   * recovers without a process restart. Only for the DOCKER_HOST (proxy/tcp) case — a
   * socket-based or docker-less deployment has no such race.
   */
  isDockerAvailable(): boolean {
    if (!this.isAvailable && !this.reinitInFlight && process.env.DOCKER_HOST) {
      this.reinitInFlight = true;
      void this.initializeDocker().finally(() => {
        this.reinitInFlight = false;
      });
    }
    return this.isAvailable;
  }

  /**
   * List all OpenWA-related containers
   */
  async listContainers(): Promise<ContainerInfo[]> {
    if (!this.docker || !this.isAvailable) {
      return [];
    }

    try {
      const containers = await this.docker.listContainers({ all: true });
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
      return [];
    }
  }

  /**
   * Which bundled (OpenWA-managed) service containers are currently RUNNING, keyed by the
   * `com.openwa.service` label (`database` | `cache` | `storage`). Lets the dashboard show the real
   * built-in state instead of the saved intent. All false when Docker is unavailable or none run.
   */
  async getRunningBuiltinServices(): Promise<{ database: boolean; cache: boolean; storage: boolean }> {
    const containers = await this.listContainers();
    const isRunning = (svc: string): boolean =>
      containers.some(
        c =>
          c.labels['com.openwa.service'] === svc && c.labels['com.openwa.builtin'] === 'true' && c.state === 'running',
      );
    return { database: isRunning('database'), cache: isRunning('cache'), storage: isRunning('storage') };
  }

  /**
   * Get container by service name or label
   */
  async getContainerByService(service: string): Promise<Docker.Container | null> {
    if (!this.docker || !this.isAvailable) {
      return null;
    }

    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`com.openwa.service=${service}`],
        },
      });

      if (containers.length > 0) {
        return this.docker.getContainer(containers[0].Id);
      }

      // Fallback: try by EXACT name (never a substring — a substring, and especially the empty
      // string, would resolve an arbitrary container). OpenWA-managed containers are `openwa-<service>`.
      const target = `openwa-${service}`;
      const allContainers = await this.docker.listContainers({ all: true });
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
   * Container specifications for optional services
   * Mirrors docker-compose.yml settings but uses Docker API directly
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
    ports?: { container: number; host: number }[];
  } | null {
    const specs: Record<string, ReturnType<typeof this.getContainerSpec>> = {
      redis: {
        image: 'redis:7-alpine',
        name: 'openwa-redis',
        alias: 'redis', // DNS alias for resolution
        cmd: ['redis-server', '--appendonly', 'yes'],
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
      },
      postgres: {
        image: 'postgres:16-alpine',
        name: 'openwa-postgres',
        alias: 'postgres',
        // Use hardcoded defaults for built-in container (don't inherit SQLite paths)
        env: ['POSTGRES_USER=openwa', 'POSTGRES_PASSWORD=openwa', 'POSTGRES_DB=openwa'],
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
      },
      minio: {
        image: 'minio/minio',
        name: 'openwa-minio',
        alias: 'minio',
        cmd: ['server', '/data', '--console-address', ':9001'],
        env: [
          // Prefer the canonical names the app/dashboard use; fall back to the legacy ones, then the
          // built-in default, so the bundled MinIO and the app share credentials.
          `MINIO_ROOT_USER=${process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || 'minioadmin'}`,
          `MINIO_ROOT_PASSWORD=${process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || 'minioadmin'}`,
        ],
        volumes: [{ name: 'openwa_minio-data', path: '/data' }],
        ports: [
          { container: 9000, host: 9000 },
          { container: 9001, host: 9001 },
        ],
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
        const info = await existing.inspect();
        if (info.State.Running) {
          this.logger.log(`Container ${spec.name} already running`);
          return true;
        }
        // Start existing container
        await existing.start();
        this.logger.log(`Started existing container: ${spec.name}`);
        return true;
      }

      // Pull image first
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
          PortBindings: spec.ports?.reduce<Record<string, { HostIp: string; HostPort: string }[]>>((acc, p) => {
            acc[`${p.container}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: p.host.toString() }];
            return acc;
          }, {}),
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
      this.logger.error(`Failed to create service ${profile}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /**
   * Start a container by service name - creates if not exists
   */
  async startService(service: string): Promise<boolean> {
    const container = await this.getContainerByService(service);

    if (!container) {
      // Container doesn't exist - create it using docker-compose
      this.logger.log(`Container for service '${service}' not found, creating...`);

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
      return this.createService(profile);
    }

    try {
      const info = await container.inspect();
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
   * Stop and remove a container by service name to save space
   */
  async removeService(profile: string): Promise<boolean> {
    this.logger.log(`Removing service with profile: ${profile}`);

    // First try to get the container and remove via dockerode
    const serviceMap: Record<string, string> = {
      postgres: 'database',
      redis: 'cache',
      minio: 'storage',
    };

    const service = serviceMap[profile] || profile;
    const container = await this.getContainerByService(service);

    if (container) {
      try {
        const info = await container.inspect();
        if (info.State.Running) {
          await container.stop();
          this.logger.log(`Stopped container: ${profile}`);
        }
        // v: true removes only the container's ANONYMOUS volumes; named datastore volumes
        // (redis/postgres/minio data) are preserved, so disable + re-enable keeps the data.
        await container.remove({ v: true });
        this.logger.log(`Removed container: ${profile}`);
        return true;
      } catch (error) {
        this.logger.error(`Failed to remove container: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    }

    // Container doesn't exist - that's fine for removal
    this.logger.log(`Container for service '${profile}' not found, nothing to remove`);
    return true;
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
      const info = await container.inspect();
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
      containersRemoved: [],
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
          // Container might not exist yet - this is expected for first-time setup
          result.errors.push(
            `Service '${profile}' container not found. It may need to be created first with docker-compose.`,
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

  /**
   * Get Docker system info
   */
  async getSystemInfo(): Promise<{ available: boolean; info?: Record<string, unknown> }> {
    if (!this.docker || !this.isAvailable) {
      return { available: false };
    }

    try {
      const info = (await this.docker.info()) as {
        Containers: number;
        ContainersRunning: number;
        ContainersPaused: number;
        ContainersStopped: number;
        Images: number;
        ServerVersion: string;
        OperatingSystem: string;
        Architecture: string;
      };
      return {
        available: true,
        info: {
          containers: info.Containers,
          containersRunning: info.ContainersRunning,
          containersPaused: info.ContainersPaused,
          containersStopped: info.ContainersStopped,
          images: info.Images,
          serverVersion: info.ServerVersion,
          operatingSystem: info.OperatingSystem,
          architecture: info.Architecture,
        },
      };
    } catch (error) {
      this.logger.error('Failed to get Docker info', error);
      return { available: false };
    }
  }
}
