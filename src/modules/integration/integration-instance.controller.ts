import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { InstanceExistsError, PluginInstanceService } from './plugin-instance.service';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstance } from './entities/plugin-instance.entity';
import { buildIngressUrls } from './ingress-url';
import { CreateInstanceDto, InstanceView, UpdateInstanceDto } from './dto/instance.dto';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

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
  async create(@Param('pluginId') pluginId: string, @Body() dto: CreateInstanceDto): Promise<InstanceView> {
    const routes = this.assertIngressCapable(pluginId);
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
      await this.scopeBinding.applyScopeBinding(pluginId, inst.sessionScope, inst.config ?? {}, inst.enabled);
      return this.view(inst, routes, /* reveal */ true);
    } catch (err) {
      if (err instanceof InstanceExistsError) throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get()
  @ApiResponse({ status: 200, description: 'Instances for the plugin (secrets masked).', type: [InstanceView] })
  async list(@Param('pluginId') pluginId: string): Promise<InstanceView[]> {
    const routes = this.pluginRoutes(pluginId);
    const rows = await this.instances.list(pluginId);
    return rows.map(r => this.view(r, routes, false));
  }

  @Get(':instanceId')
  @ApiResponse({ status: 200, description: 'The instance (secret masked).', type: InstanceView })
  async getOne(@Param('pluginId') pluginId: string, @Param('instanceId') instanceId: string): Promise<InstanceView> {
    const inst = await this.instances.resolve(pluginId, instanceId);
    if (!inst) throw new NotFoundException('instance not found');
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
  async regenerate(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
  ): Promise<InstanceView> {
    if (!(await this.instances.resolve(pluginId, instanceId))) throw new NotFoundException('instance not found');
    const inst = await this.instances.regenerateSecret(pluginId, instanceId);
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_SECRET_REGENERATED, {
      metadata: { pluginId, instanceId },
    });
    return this.view(inst, this.pluginRoutes(pluginId), true);
  }

  @Patch(':instanceId')
  @ApiResponse({ status: 200, description: 'Instance updated (secret masked).', type: InstanceView })
  async patch(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @Body() dto: UpdateInstanceDto,
  ): Promise<InstanceView> {
    let inst: PluginInstance | null = await this.instances.resolve(pluginId, instanceId);
    if (!inst) throw new NotFoundException('instance not found');
    const previousScope = inst.sessionScope;
    if (dto.enabled !== undefined) inst = await this.instances.setEnabled(pluginId, instanceId, dto.enabled);
    if (dto.sessionScope !== undefined || dto.config !== undefined) {
      inst = await this.instances.update(
        pluginId,
        instanceId,
        { sessionScope: dto.sessionScope, config: dto.config },
        this.schemaFor(pluginId),
      );
    }
    const updated = inst as PluginInstance;
    // If the bound session changed, tear down the OLD scope (incl. a wildcard/null scope) so it stops
    // firing with stale config. The new scope is (re)bound right after; teardown runs first with the new
    // scope already persisted, so the wildcard retirement check sees the current state correctly.
    if (previousScope !== updated.sessionScope) {
      await this.scopeBinding.applyScopeBinding(pluginId, previousScope, {}, false);
    }
    await this.scopeBinding.applyScopeBinding(pluginId, updated.sessionScope, updated.config ?? {}, updated.enabled);
    return this.view(updated, this.pluginRoutes(pluginId), false);
  }

  @Delete(':instanceId')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Instance deleted and its session scope torn down.' })
  async remove(@Param('pluginId') pluginId: string, @Param('instanceId') instanceId: string): Promise<void> {
    const inst = await this.instances.resolve(pluginId, instanceId);
    if (!inst) throw new NotFoundException('instance not found');
    const scope = inst.sessionScope;
    // Delete the row FIRST, then tear down its scope: for a wildcard/null scope the teardown lists the
    // remaining instances to decide whether to retire '*', and that check must not count this instance.
    await this.instances.remove(pluginId, instanceId);
    await this.scopeBinding.applyScopeBinding(pluginId, scope, {}, false);
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_DELETED, { metadata: { pluginId, instanceId } });
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
    const masked = reveal ? inst : this.instances.maskedView(inst, schema);
    return {
      id: masked.id,
      pluginId: masked.pluginId,
      instanceId: masked.instanceId,
      sessionScope: masked.sessionScope,
      secret: masked.secret,
      verifyToken: reveal ? inst.verifyToken : inst.verifyToken ? '***' : null,
      config: masked.config,
      enabled: masked.enabled,
      createdAt: masked.createdAt,
      updatedAt: masked.updatedAt,
      ingressUrls: buildIngressUrls(process.env.BASE_URL, inst.pluginId, inst.instanceId, routes),
    };
  }
}
