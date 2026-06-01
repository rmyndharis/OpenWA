import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.io adapter backed by Redis pub/sub (Tier 4).
 *
 * The default in-memory adapter keeps room membership and broadcasts local to
 * one process: a client connected to node A never receives events emitted on
 * node B. This adapter relays every broadcast through Redis so all nodes share
 * one logical Socket.io server. Only wired when CLUSTER_ENABLED is on.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /**
   * Establish the pub/sub client pair and build the adapter factory. Call once
   * before `useWebSocketAdapter`. The sub client must be a separate connection
   * — a Redis client in subscribe mode cannot issue normal commands.
   */
  async connectToRedis(config: ConfigService): Promise<void> {
    const host = config.get<string>('redis.host', 'localhost');
    const port = config.get<number>('redis.port', 6379);
    const password = config.get<string>('redis.password');

    this.pubClient = new Redis({ host, port, password });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err: Error) => this.logger.error(`Redis pub client error: ${err.message}`));
    this.subClient.on('error', (err: Error) => this.logger.error(`Redis sub client error: ${err.message}`));

    // Fail fast at bootstrap if Redis is unreachable, before createAdapter puts
    // the sub client into subscriber mode.
    await Promise.all([this.pubClient.ping(), this.subClient.ping()]);

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log(`Socket.io Redis adapter connected to ${host}:${port}`);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}
