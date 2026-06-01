import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { IWhatsAppEngine, EngineStatus, IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { SessionRegistry } from './session-registry.service';
import { SessionOwnedElsewhereException } from './exceptions/session-owned-elsewhere.exception';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly sessionRegistry: SessionRegistry,
  ) {}

  /**
   * Run an async side-effect (webhook dispatch, hook chain, DB touch) without
   * blocking the engine callback, but log rejections instead of swallowing
   * them. Replaces bare `void promise` so failed deliveries are observable.
   */
  private safeDispatch(promise: Promise<unknown>, action: string, sessionId: string): void {
    void promise.catch(error => {
      this.logger.error(`Background task '${action}' failed`, error instanceof Error ? error.message : String(error), {
        sessionId,
        action,
      });
    });
  }

  /** Synchronous variant for emit-style side-effects that may throw. */
  private safeEmit(fn: () => void, action: string, sessionId: string): void {
    try {
      fn();
    } catch (error) {
      this.logger.error(`Emit '${action}' failed`, error instanceof Error ? error.message : String(error), {
        sessionId,
        action,
      });
    }
  }

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
    ];

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Clean up all engines on shutdown
    for (const [sessionId, engine] of this.engines) {
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      await engine.destroy();
    }
    this.engines.clear();

    // Clear all reconnect timers
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Stop engine if running
    const engine = this.engines.get(id);
    if (engine) {
      await engine.destroy();
      this.engines.delete(id);
    }
    await this.sessionRegistry.release(id);

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });
    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    if (this.engines.has(id)) {
      throw new BadRequestException('Session is already started');
    }

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = session.config as {
      maxReconnectAttempts?: number;
      reconnectBaseDelay?: number;
    } | null;
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      maxAttempts: config?.maxReconnectAttempts ?? 5,
      baseDelay: config?.reconnectBaseDelay ?? 5000,
    });

    await this.initializeEngine(id, session);
    return this.findOne(id);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);

    // Claim cluster ownership of this session (no-op when CLUSTER_ENABLED off).
    await this.sessionRegistry.claim(id);

    await engine.initialize({
      onQRCode: (): void => this.handleQRCode(id),
      onReady: (phone: string, pushName: string): void => this.handleReady(id, phone, pushName),
      onMessage: (message: IncomingMessage): void => this.handleMessage(id, message),
      onMessageSent: (message: IncomingMessage): void => this.handleMessageSent(id, message),
      onMessageAck: (messageId: string, ack: number): void => this.handleMessageAck(id, messageId, ack),
      onDisconnected: (reason: string): void => this.handleDisconnected(id, session, reason),
      onStateChanged: (engineState: EngineStatus): void => this.handleStateChanged(id, engineState),
    });

    await this.updateStatus(id, SessionStatus.INITIALIZING);
  }

  // ========== Engine event handlers ==========
  // Named so each callback is independently readable/testable; behavior is
  // identical to the previously-inlined closures in initializeEngine.

  private handleQRCode(id: string): void {
    this.logger.log('QR code generated', {
      sessionId: id,
      action: 'qr_generated',
    });

    // Execute hook for QR event
    void this.hookManager.execute(
      'session:qr',
      { sessionId: id },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    void this.updateStatus(id, SessionStatus.QR_READY);
  }

  private handleReady(id: string, phone: string, pushName: string): void {
    this.logger.log(`Session ready: ${phone}`, {
      sessionId: id,
      phone,
      pushName,
      action: 'ready',
    });

    // Execute hook for ready event
    void this.hookManager.execute(
      'session:ready',
      { phone, pushName },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    // Reset reconnect attempts on successful connection
    const reconnectState = this.reconnectStates.get(id);
    if (reconnectState) {
      reconnectState.attempts = 0;
    }

    void this.sessionRepository.update(id, {
      status: SessionStatus.READY,
      phone,
      pushName,
      connectedAt: new Date(),
      lastActiveAt: new Date(),
    });
  }

  private handleMessage(id: string, message: IncomingMessage): void {
    this.logger.debug(`Message received from ${message.from}`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      action: 'message_received',
    });
    // Update last active timestamp
    this.safeDispatch(this.sessionRepository.update(id, { lastActiveAt: new Date() }), 'touch:lastActiveAt', id);
    // Convert IncomingMessage to plain object for dispatch
    const messageData = { ...message };

    // Execute hook for message received - plugins can modify or stop processing
    this.safeDispatch(
      this.hookManager
        .execute('message:received', messageData, {
          sessionId: id,
          source: 'Engine',
        })
        .then(({ continue: shouldContinue, data: finalMessage }) => {
          if (!shouldContinue) {
            // Plugin stopped processing (e.g., auto-reply handled it)
            return;
          }

          // Dispatch to webhooks with potentially modified message
          this.safeDispatch(
            this.webhookService.dispatch(id, 'message.received', finalMessage),
            'webhook:message.received',
            id,
          );
          // Emit real-time event to WebSocket clients
          this.safeEmit(() => this.eventsGateway.emitMessage(id, finalMessage), 'emit:message.received', id);
        }),
      'hook:message:received',
      id,
    );
  }

  private handleMessageSent(id: string, message: IncomingMessage): void {
    this.logger.debug(`Message sent to ${message.to}`, {
      sessionId: id,
      messageId: message.id,
      to: message.to,
      action: 'message_sent',
    });

    this.safeDispatch(this.sessionRepository.update(id, { lastActiveAt: new Date() }), 'touch:lastActiveAt', id);

    const messageData = { ...message };
    this.safeDispatch(this.webhookService.dispatch(id, 'message.sent', messageData), 'webhook:message.sent', id);
    this.safeEmit(() => this.eventsGateway.emitMessageSent(id, messageData), 'emit:message.sent', id);
  }

  private handleMessageAck(id: string, messageId: string, ack: number): void {
    const ackData = {
      messageId,
      ack,
      ackName: this.resolveAckName(ack),
    };

    this.safeDispatch(this.webhookService.dispatch(id, 'message.ack', ackData), 'webhook:message.ack', id);
    this.safeEmit(() => this.eventsGateway.emitMessageAck(id, ackData), 'emit:message.ack', id);
  }

  private handleDisconnected(id: string, session: Session, reason: string): void {
    this.logger.warn(`Session disconnected: ${reason}`, {
      sessionId: id,
      reason,
      action: 'disconnected',
    });

    // Execute hook for disconnected event
    void this.hookManager.execute(
      'session:disconnected',
      { reason },
      {
        sessionId: id,
        source: 'Engine',
      },
    );

    void this.updateStatus(id, SessionStatus.DISCONNECTED);

    // Attempt to reconnect
    this.scheduleReconnect(id, session);
  }

  private handleStateChanged(id: string, engineState: EngineStatus): void {
    const statusMap: Record<EngineStatus, SessionStatus> = {
      [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
      [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
      [EngineStatus.QR_READY]: SessionStatus.QR_READY,
      [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
      [EngineStatus.READY]: SessionStatus.READY,
      [EngineStatus.FAILED]: SessionStatus.FAILED,
    };
    const newStatus = statusMap[engineState];
    if (newStatus) {
      void this.updateStatus(id, newStatus);
    }
  }

  private scheduleReconnect(id: string, session: Session): void {
    const state = this.reconnectStates.get(id);
    if (!state) return;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const delay = state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000;
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await oldEngine.destroy();
        this.engines.delete(id);
      }

      // Re-initialize
      await this.initializeEngine(id, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  private resolveAckName(ack: number): string {
    switch (ack) {
      case -1:
        return 'error';
      case 0:
        return 'pending';
      case 1:
        return 'server';
      case 2:
        return 'device';
      case 3:
        return 'read';
      case 4:
        return 'played';
      default:
        return `unknown(${ack})`;
    }
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    const engine = this.engines.get(id);

    if (engine) {
      await engine.disconnect();
      this.engines.delete(id);
    }
    await this.sessionRegistry.release(id);

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  /**
   * Resolve the live engine for a session or throw a meaningful error. When the
   * engine is not held locally and cluster mode is on, consult the ownership
   * registry: if another node owns it, surface a 409 naming that node instead
   * of a misleading "not active". Owner-aware replacement for callers that
   * currently do `getEngine` + generic throw.
   */
  async resolveEngine(id: string): Promise<IWhatsAppEngine> {
    const engine = this.engines.get(id);
    if (engine) {
      return engine;
    }
    if (this.sessionRegistry.isEnabled) {
      const owner = await this.sessionRegistry.getOwner(id);
      if (owner && owner !== this.sessionRegistry.instanceId) {
        throw new SessionOwnedElsewhereException(id, owner);
      }
    }
    throw new BadRequestException(`Session '${id}' is not active. Start the session first.`);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
