import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryDeepPartialEntity, Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { awaitNoOpenTransaction } from '../../common/utils/shared-connection';
import type { PluginConfigSchema, PluginManifest } from '../../core/plugins/plugin.interfaces';
import {
  type ConfigLayerManifest,
  redirectedHostKeys,
  restorableConfig,
  stripInheritedSecretsForRedirect,
} from '../../core/plugins/plugin-activation';
import { redactSecretConfig, restoreSecretConfig, SECRET_SENTINEL } from '../plugins/redact-config';
// Type-only: the module binds this class to PLUGIN_INSTANCE_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type { PluginInstancePort } from '../../core/plugins/plugin-host-ports';

// A supplied ingress secret must be a real, guessing-resistant value; an empty/short one would make the
// public HMAC forgeable. Absent => auto-generate. Trimmed so pasted whitespace can't slip a weak secret in.
function normalizeSecret(supplied?: string): string {
  if (supplied === undefined) return randomBytes(32).toString('hex');
  const s = supplied.trim();
  if (s.length < 16) {
    throw new BadRequestException('instance secret must be a non-empty string of at least 16 characters');
  }
  return s;
}

export class InstanceExistsError extends Error {
  constructor(pluginId: string, instanceId: string) {
    super(`instance ${instanceId} already exists for plugin ${pluginId}`);
    this.name = 'InstanceExistsError';
  }
}

const INSTANCE_SANITIZATION_DRAIN_MS = 5000;

interface SanitizationBarrier {
  promise: Promise<void>;
  isRetry: boolean;
}

@Injectable()
export class PluginInstanceService implements PluginInstancePort, OnModuleDestroy {
  /** Per-plugin write/sanitization queue so create/update/remove cannot interleave with redirect sanitization. */
  private readonly mutationChains = new Map<string, Promise<void>>();
  /** Tracks which pluginId's mutation turn the current async call holds so internal resolve() never self-deadlocks. */
  private readonly inMutation = new AsyncLocalStorage<string>();
  /** Per-plugin set of active sanitization/retry barriers awaited by external reads before reading persisted rows. */
  private readonly pendingSanitizations = new Map<string, Set<SanitizationBarrier>>();
  /** Redirect sanitizations whose DB write failed after commit; retried fail-closed before subsequent reads. */
  private readonly pendingRetries = new Map<
    string,
    Array<{ redirectedKeys: string[]; manifest: ConfigLayerManifest }>
  >();

  constructor(@InjectRepository(PluginInstance, 'data') private readonly repo: Repository<PluginInstance>) {}

  async onModuleDestroy(): Promise<void> {
    const inflight = [
      ...this.mutationChains.values(),
      ...[...this.pendingSanitizations.values()].flatMap(set => [...set].map(entry => entry.promise)),
    ];
    if (inflight.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(inflight),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, INSTANCE_SANITIZATION_DRAIN_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private addBarrier(pluginId: string, barrier: SanitizationBarrier): void {
    let set = this.pendingSanitizations.get(pluginId);
    if (!set) {
      set = new Set();
      this.pendingSanitizations.set(pluginId, set);
    }
    set.add(barrier);
  }

  private removeBarrier(pluginId: string, barrier: SanitizationBarrier): void {
    const set = this.pendingSanitizations.get(pluginId);
    if (!set) return;
    set.delete(barrier);
    if (set.size === 0) this.pendingSanitizations.delete(pluginId);
  }

  private runTrackedRetries(
    pluginId: string,
    retries: Array<{ redirectedKeys: string[]; manifest: ConfigLayerManifest }>,
    run: () => Promise<void>,
  ): Promise<void> {
    const retryPromise = run().catch((err: unknown) => {
      // Restore pendingRetries BEFORE finally removes the barrier so no arriving reader slips through.
      const current = this.pendingRetries.get(pluginId) ?? [];
      this.pendingRetries.set(pluginId, [...retries, ...current]);
      throw err;
    });
    const tracked = retryPromise.finally(() => {
      this.removeBarrier(pluginId, entry);
    });
    void tracked.catch(() => undefined);
    const entry: SanitizationBarrier = { promise: tracked, isRetry: true };
    // Register the active retry barrier synchronously BEFORE removing pendingRetries.
    this.addBarrier(pluginId, entry);
    this.pendingRetries.delete(pluginId);
    return entry.promise;
  }

  private serializeMutation<T>(pluginId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.mutationChains.get(pluginId) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(() => this.inMutation.run(pluginId, op));
    const settled = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.mutationChains.get(pluginId) === settled) {
          this.mutationChains.delete(pluginId);
        }
      });
    this.mutationChains.set(pluginId, settled);
    return result;
  }

  private async runSanitizePass(
    pluginId: string,
    redirectedKeys: readonly string[],
    manifest: ConfigLayerManifest,
  ): Promise<void> {
    const rows = await this.repo.find({ where: { pluginId } });
    for (const row of rows) {
      if (!row.config) continue;
      const stripped = stripInheritedSecretsForRedirect(row.config, redirectedKeys, manifest);
      if (stripped === undefined) continue;
      await this.repo.update({ id: row.id }, { config: stripped } as QueryDeepPartialEntity<PluginInstance>);
    }
  }

  private async awaitPendingSanitization(pluginId: string): Promise<void> {
    // When already holding this pluginId's exclusive mutation turn, no earlier sanitization is still in
    // flight and any later sanitization is queued behind us; only failed post-commit retries need draining
    // (still tracked in pendingSanitizations so concurrent external readers wait for the retry pass).
    if (this.inMutation.getStore() === pluginId) {
      while (true) {
        const retries = this.pendingRetries.get(pluginId);
        if (!retries?.length) return;
        await this.runTrackedRetries(pluginId, retries, async () => {
          for (const item of retries) {
            await this.runSanitizePass(pluginId, item.redirectedKeys, item.manifest);
          }
        });
      }
    }

    while (true) {
      const barriers = this.pendingSanitizations.get(pluginId);
      if (barriers?.size) {
        for (const barrier of [...barriers]) {
          if (barrier.isRetry) {
            await barrier.promise;
          } else {
            await barrier.promise.catch(() => undefined);
          }
        }
        continue;
      }
      const retries = this.pendingRetries.get(pluginId);
      if (!retries?.length) return;
      await this.runTrackedRetries(pluginId, retries, () =>
        this.serializeMutation(pluginId, async () => {
          for (const item of retries) {
            await this.runSanitizePass(pluginId, item.redirectedKeys, item.manifest);
          }
        }),
      );
    }
  }

  private async awaitAllPendingSanitizations(): Promise<void> {
    while (this.pendingSanitizations.size > 0 || this.pendingRetries.size > 0) {
      const ids = new Set([...this.pendingSanitizations.keys(), ...this.pendingRetries.keys()]);
      for (const pluginId of ids) {
        await this.awaitPendingSanitization(pluginId);
      }
    }
  }

  /**
   * Strip secrets from every persisted instance row of `pluginId` whose config leaves any host key
   * redirected between `previousBase` and `nextBase` unset (inheriting the base host). Registers the
   * in-flight barrier synchronously so subsequent reads and mutations serialize cleanly around it.
   */
  sanitizeForBaseRedirect(
    pluginId: string,
    previousBase: Record<string, unknown>,
    nextBase: Record<string, unknown>,
    manifest: ConfigLayerManifest,
    options?: { retryOnFailure?: boolean },
  ): Promise<void> {
    const redirectedKeys = redirectedHostKeys(previousBase, nextBase, manifest);
    if (redirectedKeys.length === 0) return Promise.resolve();
    const retryOnFailure = options?.retryOnFailure ?? true;
    const task = this.serializeMutation(pluginId, () => this.runSanitizePass(pluginId, redirectedKeys, manifest));
    const tracked = task
      .catch(() => {
        if (retryOnFailure) {
          const list = this.pendingRetries.get(pluginId) ?? [];
          list.push({ redirectedKeys, manifest });
          this.pendingRetries.set(pluginId, list);
        }
      })
      .finally(() => {
        this.removeBarrier(pluginId, entry);
      });
    const entry: SanitizationBarrier = { promise: tracked, isRetry: false };
    this.addBarrier(pluginId, entry);
    return task;
  }

  // A plain INSERT, never save(): with the primary key set, save() re-selects and turns a concurrent
  // duplicate into an UPDATE that overwrites the first row's secret. Null when the id already exists.
  private async insert(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance | null> {
    const inst = this.repo.create({
      id: `${pluginId}:${instanceId}`,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope || null,
      secret: normalizeSecret(opts.secret),
      verifyToken: opts.verifyToken || randomBytes(16).toString('hex'),
      config: opts.config ?? null,
      enabled: true,
    });
    try {
      await this.repo.insert(inst as QueryDeepPartialEntity<PluginInstance>);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    return inst;
  }

  async resolve(pluginId: string, instanceId: string): Promise<PluginInstance | null> {
    await this.awaitPendingSanitization(pluginId);
    return this.repo.findOne({ where: { id: `${pluginId}:${instanceId}` } });
  }

  // Operator-facing view: never leak the raw secret, and mask any `secret:true` config field (e.g. a
  // provider apiToken) per the plugin's configSchema — recursively, at any depth, and fail-closed when
  // the schema is unavailable — by reusing the shared redactSecretConfig (single source of truth).
  maskedView(instance: PluginInstance, schema?: PluginConfigSchema): PluginInstance {
    return {
      ...instance,
      secret: SECRET_SENTINEL,
      config: instance.config == null ? instance.config : redactSecretConfig(instance.config, schema),
    };
  }

  create(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    return this.serializeMutation(pluginId, async () => {
      if (await this.resolve(pluginId, instanceId)) throw new InstanceExistsError(pluginId, instanceId);
      const inst = await this.insert(pluginId, instanceId, opts);
      if (!inst) throw new InstanceExistsError(pluginId, instanceId);
      return inst;
    });
  }

  async list(pluginId: string): Promise<PluginInstance[]> {
    await this.awaitPendingSanitization(pluginId);
    return this.repo.find({ where: { pluginId } });
  }

  /** Every persisted instance across all plugins — used by the boot-time scope-binding reconciliation. */
  async listAll(): Promise<PluginInstance[]> {
    await this.awaitAllPendingSanitizations();
    return this.repo.find();
  }

  // update() and regenerateSecret() write only the columns they change, and only to a row that still
  // exists: a whole-row save() would re-insert a row deleted meanwhile, or write back a stale secret
  // over a concurrent rotation. Both re-read the row after the write so the result carries the fresh
  // updatedAt the database stamped.
  async regenerateSecret(pluginId: string, instanceId: string): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    const secret = randomBytes(32).toString('hex');
    const written = inst ? (await this.repo.update({ id: inst.id }, { secret })).affected : 0;
    return written ? this.resolve(pluginId, instanceId) : null;
  }

  update(
    pluginId: string,
    instanceId: string,
    patch: { enabled?: boolean; sessionScope?: string | null; config?: Record<string, unknown> },
    schema?: PluginConfigSchema,
    layer?: { net?: PluginManifest['net']; beneath?: Record<string, unknown> },
  ): Promise<PluginInstance | null> {
    return this.serializeMutation(pluginId, async () => {
      const inst = await this.resolve(pluginId, instanceId);
      if (!inst) return null;
      const changes: Partial<Pick<PluginInstance, 'enabled' | 'sessionScope' | 'config'>> = {};
      if (patch.enabled !== undefined) changes.enabled = patch.enabled;
      if (patch.sessionScope !== undefined) changes.sessionScope = patch.sessionScope || null;
      if (patch.config !== undefined) {
        // The operator view masks secrets as the sentinel, so a round-tripped config carries '***' for
        // unchanged secrets. Restore the stored values instead of persisting the mask (which would corrupt
        // the credential); genuinely-new values are written as provided.
        // A PATCH that points a host key at another origin gets no stored secret back, see restorableConfig.
        const stored = restorableConfig(
          inst.config ?? undefined,
          patch.config,
          { configSchema: schema, net: layer?.net },
          layer?.beneath,
        );
        changes.config = restoreSecretConfig(patch.config, stored, schema);
      }
      if (Object.keys(changes).length === 0) return inst;
      const { affected } = await this.repo.update({ id: inst.id }, changes as QueryDeepPartialEntity<PluginInstance>);
      return affected ? this.resolve(pluginId, instanceId) : null;
    });
  }

  remove(pluginId: string, instanceId: string): Promise<boolean> {
    return this.serializeMutation(pluginId, async () => {
      await this.awaitPendingSanitization(pluginId);
      // On SQLite every caller shares one connection: opened beside another caller's transaction, this one would be a
      // savepoint in it or carry that one's writes, and either rollback could undo what the other had answered for.
      if (!(await awaitNoOpenTransaction(this.repo.manager.dataSource))) {
        throw new ServiceUnavailableException(
          `Instance ${instanceId} was not deleted: another database transaction stayed open. Retry the delete.`,
        );
      }
      return this.repo.manager.transaction(async manager => {
        const result = await manager.delete(PluginInstance, { id: `${pluginId}:${instanceId}` });
        // Its conversation mappings stay, so the same instance provisioned again keeps its provider
        // conversations. A takeover they hold does not: it is scoped to the chat, not to the plugin, and
        // with the instance gone nothing can hand the chat back, so it would keep every other plugin
        // silent there for good.
        await manager.update(
          ConversationMapping,
          { pluginId, instanceId, handoverState: In(['human', 'closed']) },
          { handoverState: 'bot' },
        );
        return (result.affected ?? 0) > 0;
      });
    });
  }
}
