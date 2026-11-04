import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { isAllSessionsScope } from '../../core/plugins/plugin-activation';
import { InstanceExistsError, PluginInstanceService } from './plugin-instance.service';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstance } from './entities/plugin-instance.entity';
import { buildIngressUrls } from './ingress-url';
import { CreateInstanceDto, InstanceView, UpdateInstanceDto } from './dto/instance.dto';
import { sessionScopeVisible } from '../../common/security/session-scope';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

// A session-restricted key narrows nothing outside its own sessions: binding or releasing its instance
// must not retire the plugin's all-sessions activation, which an unrestricted operator set.
const isScopedKey = (apiKey: ApiKey | undefined): boolean => (apiKey?.allowedSessions?.length ?? 0) > 0;

/**
 * What the instance has put into the plugin's base config: its config while it is enabled on the wildcard
 * scope, nothing otherwise. That merged config is where a secret the instance stops contributing would stay
 * behind (see ScopeBindingService.applyScopeBinding), and an instance that was not contributing, being
 * disabled or on one session, left nothing there to take back.
 */
const contributedConfig = (inst: PluginInstance): Record<string, unknown> | undefined =>
  inst.enabled && isAllSessionsScope(inst.sessionScope) ? (inst.config ?? undefined) : undefined;

// ADMIN-only provisioning surface for per-plugin instances (e.g. one Chatwoot account). Only plugins
// that declare an ingress route AND the webhook:ingress permission can have instances; everything
// else is rejected before touching persistence.
@ApiTags('integration')
@Controller('integration/plugins/:pluginId/instances')
@RequireRole(ApiKeyRole.ADMIN)
export class IntegrationInstanceController {
  constructor(
    private readonly instances: PluginInstanceService,
    private readonly loader: PluginLoaderService,
    private readonly audit: AuditService,
    private readonly scopeBinding: ScopeBindingService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiResponse({
    status: 201,
    description:
      'Instance created. The plaintext ingress secret and verifyToken are revealed once in this response — store them immediately (both masked on every later read).',
    type: InstanceView,
  })
  @ApiResponse({ status: 400, description: 'Validation failed, or the plugin is not ingress-capable.' })
  @ApiResponse({ status: 403, description: "sessionScope is outside the key's allowedSessions." })
  @ApiResponse({ status: 404, description: 'Plugin not found.' })
  @ApiResponse({ status: 409, description: 'An instance with that id already exists for the plugin' })
  async create(
    @Param('pluginId') pluginId: string,
    @Body() dto: CreateInstanceDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<InstanceView> {
    const routes = this.assertIngressCapable(pluginId);
    this.assertScopeWritable(apiKey, dto.sessionScope);
    try {
      const inst = await this.instances.create(pluginId, dto.instanceId, {
        sessionScope: dto.sessionScope,
        verifyToken: dto.verifyToken,
        secret: dto.secret,
        config: dto.config,
      });
      void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_CREATED, {
        metadata: { pluginId, instanceId: dto.instanceId },
      });
      await this.scopeBinding.applyScopeBinding(pluginId, inst.sessionScope, inst.config ?? {}, inst.enabled, {
        additive: isScopedKey(apiKey),
      });
      return this.view(inst, routes, /* reveal */ true);
    } catch (err) {
      if (err instanceof InstanceExistsError) throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get()
  @ApiResponse({ status: 200, description: 'Instances for the plugin (secrets masked).', type: [InstanceView] })
  async list(@Param('pluginId') pluginId: string, @CurrentApiKey() apiKey?: ApiKey): Promise<InstanceView[]> {
    const routes = this.pluginRoutes(pluginId);
    const rows = await this.instances.list(pluginId);
    return rows
      .filter(r => sessionScopeVisible(apiKey?.allowedSessions, r.sessionScope))
      .map(r => this.view(r, routes, false));
  }

  @Get(':instanceId')
  @ApiResponse({ status: 200, description: 'The instance (secret masked).', type: InstanceView })
  @ApiResponse({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." })
  async getOne(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<InstanceView> {
    const inst = await this.resolveVisible(pluginId, instanceId, apiKey);
    return this.view(inst, this.pluginRoutes(pluginId), false);
  }

  @Post(':instanceId/regenerate-secret')
  @HttpCode(200)
  @ApiResponse({
    status: 200,
    description:
      'Secret regenerated. The new plaintext secret is revealed once in this response; the verifyToken is also shown (unchanged).',
    type: InstanceView,
  })
  @ApiResponse({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." })
  async regenerate(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<InstanceView> {
    await this.resolveVisible(pluginId, instanceId, apiKey);
    const inst = await this.instances.regenerateSecret(pluginId, instanceId);
    // regenerateSecret() answers null when the row was deleted after resolveVisible read it.
    if (!inst) throw new NotFoundException('instance not found');
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_SECRET_REGENERATED, {
      metadata: { pluginId, instanceId },
    });
    return this.view(inst, this.pluginRoutes(pluginId), true);
  }

  @Patch(':instanceId')
  @ApiResponse({ status: 200, description: 'Instance updated (secret masked).', type: InstanceView })
  @ApiResponse({ status: 400, description: 'Validation failed, or the masked config could not be restored.' })
  @ApiResponse({ status: 403, description: "The new sessionScope is outside the key's allowedSessions." })
  @ApiResponse({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." })
  @ApiResponse({
    status: 409,
    description:
      'The body changes config while the plugin is not loaded. Nothing is written; a body without config still ' +
      'applies enabled and sessionScope.',
  })
  async patch(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @Body() dto: UpdateInstanceDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<InstanceView> {
    let inst: PluginInstance | null = await this.resolveVisible(pluginId, instanceId, apiKey);
    if (dto.sessionScope !== undefined) this.assertScopeWritable(apiKey, dto.sessionScope);
    const previousScope = inst.sessionScope;
    const previousConfig = contributedConfig(inst);
    // One update() writes every field in a single save. Restoring the masked config can refuse the
    // PATCH with a 400 before that save, so a rejected body changes nothing, `enabled` included.
    if (dto.enabled !== undefined || dto.sessionScope !== undefined || dto.config !== undefined) {
      const plugin = this.loader.getPlugin(pluginId);
      // An instance row outlives its plugin. Without the manifest there are no host keys to tell a moved host
      // from an unchanged one, and echoing the mask would put every stored secret back beside whatever host
      // the body names, so a config write waits for the plugin to be loaded.
      if (dto.config && !plugin) {
        throw new ConflictException(`Plugin ${pluginId} is not loaded, so its instance config cannot be changed`);
      }
      inst = await this.instances.update(
        pluginId,
        instanceId,
        { enabled: dto.enabled, sessionScope: dto.sessionScope, config: dto.config },
        this.schemaFor(pluginId),
        { net: plugin?.manifest.net, beneath: plugin?.config },
      );
      // update() answers null when the row was deleted after resolveVisible read it.
      if (!inst) throw new NotFoundException('instance not found');
    }
    const updated = inst;
    // If the bound session changed, tear down the OLD scope (incl. a wildcard/null scope) so it stops
    // firing with stale config. The new scope is (re)bound right after; teardown runs first with the new
    // scope already persisted, so the wildcard retirement check sees the current state correctly.
    if (previousScope !== updated.sessionScope) {
      // A move between the spellings of the wildcard scope is re-bound right below: retracting here would
      // only hand the running plugin a config without its secrets for the length of one call.
      await this.scopeBinding.applyScopeBinding(pluginId, previousScope, {}, false, {
        previousConfig: isAllSessionsScope(updated.sessionScope) ? undefined : previousConfig,
        additive: isScopedKey(apiKey),
      });
    }
    await this.scopeBinding.applyScopeBinding(pluginId, updated.sessionScope, updated.config ?? {}, updated.enabled, {
      previousConfig,
      additive: isScopedKey(apiKey),
    });
    // Audit the successful update with the CHANGED FIELD NAMES only — never the values: a config patch
    // can carry credentials, and audit metadata is not a credential store.
    const updatedFields = (['enabled', 'sessionScope', 'config'] as const).filter(f => dto[f] !== undefined);
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_UPDATED, {
      metadata: { pluginId, instanceId, updated: updatedFields },
    });
    return this.view(updated, this.pluginRoutes(pluginId), false);
  }

  @Delete(':instanceId')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Instance deleted and its session scope torn down.' })
  @ApiResponse({ status: 404, description: "Unknown instance, or one outside the key's allowedSessions." })
  @ApiResponse({
    status: 503,
    description: 'On SQLite, another database transaction stayed open for 10 s; nothing was deleted, so retry.',
  })
  async remove(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    const inst = await this.resolveVisible(pluginId, instanceId, apiKey);
    const scope = inst.sessionScope;
    // Delete the row FIRST, then tear down its scope: for a wildcard/null scope the teardown lists the
    // remaining instances to decide whether to retire '*', and that check must not count this instance.
    await this.instances.remove(pluginId, instanceId);
    await this.scopeBinding.applyScopeBinding(pluginId, scope, {}, false, {
      previousConfig: contributedConfig(inst),
      additive: isScopedKey(apiKey),
    });
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_DELETED, { metadata: { pluginId, instanceId } });
  }

  // Resolve an instance the calling key may see: a session-scoped key only reaches instances bound
  // to one of its own sessions. Out-of-scope instances answer 404 (identical to a missing one) so
  // the endpoint cannot be used to probe which instances exist on other sessions.
  private async resolveVisible(pluginId: string, instanceId: string, apiKey?: ApiKey): Promise<PluginInstance> {
    const inst = await this.instances.resolve(pluginId, instanceId);
    if (!inst || !sessionScopeVisible(apiKey?.allowedSessions, inst.sessionScope)) {
      throw new NotFoundException('instance not found');
    }
    return inst;
  }

  // A scoped key may only bind an instance to a session inside its own fence — never to another
  // session, and never to the all-sessions (omitted/'*') scope.
  private assertScopeWritable(apiKey: ApiKey | undefined, sessionScope: string | null | undefined): void {
    if (!sessionScopeVisible(apiKey?.allowedSessions, sessionScope)) {
      throw new ForbiddenException("sessionScope is outside the API key's allowed sessions");
    }
  }

  // The plugin must exist AND declare ingress + the webhook:ingress permission to have instances.
  private assertIngressCapable(pluginId: string): string[] {
    const plugin = this.loader.getPlugin(pluginId);
    if (!plugin) throw new NotFoundException(`plugin ${pluginId} not found`);
    const routes = plugin.manifest.ingress?.map(r => r.route) ?? [];
    const hasPerm = (plugin.manifest.permissions ?? []).includes('webhook:ingress');
    if (routes.length === 0 || !hasPerm) {
      throw new BadRequestException(`plugin ${pluginId} is not ingress-capable`);
    }
    return routes;
  }

  // Best-effort routes for read responses; empty when the plugin is gone or non-ingress (no throw).
  private pluginRoutes(pluginId: string): string[] {
    return this.loader.getPlugin(pluginId)?.manifest.ingress?.map(r => r.route) ?? [];
  }

  // The plugin's declarative config schema, used to restore masked secrets on update (undefined when the
  // plugin is unloaded — restoreSecretConfig then fails closed).
  private schemaFor(pluginId: string) {
    return this.loader.getPlugin(pluginId)?.manifest.configSchema;
  }

  private view(inst: PluginInstance, routes: string[], reveal: boolean): InstanceView {
    const schema = this.loader.getPlugin(inst.pluginId)?.manifest.configSchema;
    // ALWAYS start from the masked view — including the one-shot reveal responses (create /
    // regenerate-secret). `reveal` unmasks ONLY the two fields documented as "revealed once" (the
    // ingress secret and the verifyToken); config fields flagged `secret` in the plugin's schema
    // stay masked at any depth on every response, so a reveal can never echo a stored credential.
    const masked = this.instances.maskedView(inst, schema);
    return {
      id: masked.id,
      pluginId: masked.pluginId,
      instanceId: masked.instanceId,
      sessionScope: masked.sessionScope,
      secret: reveal ? inst.secret : masked.secret,
      verifyToken: reveal ? inst.verifyToken : inst.verifyToken ? '***' : null,
      config: masked.config,
      enabled: masked.enabled,
      createdAt: masked.createdAt,
      updatedAt: masked.updatedAt,
      ingressUrls: buildIngressUrls(process.env.BASE_URL, inst.pluginId, inst.instanceId, routes),
    };
  }
}
