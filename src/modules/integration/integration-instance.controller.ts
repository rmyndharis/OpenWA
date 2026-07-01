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
import { PluginInstance } from './entities/plugin-instance.entity';
import { buildIngressUrls } from './ingress-url';
import { CreateInstanceDto, InstanceView, UpdateInstanceDto } from './dto/instance.dto';

// ADMIN-only provisioning surface for per-plugin instances (e.g. one Chatwoot account). Only plugins
// that declare an ingress route AND the webhook:ingress permission can have instances; everything
// else is rejected before touching persistence.
@Controller('integration/plugins/:pluginId/instances')
@RequireRole(ApiKeyRole.ADMIN)
export class IntegrationInstanceController {
  constructor(
    private readonly instances: PluginInstanceService,
    private readonly loader: PluginLoaderService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Param('pluginId') pluginId: string, @Body() dto: CreateInstanceDto): Promise<InstanceView> {
    const routes = this.assertIngressCapable(pluginId);
    try {
      const inst = await this.instances.create(pluginId, dto.instanceId, {
        sessionScope: dto.sessionScope,
        verifyToken: dto.verifyToken,
        config: dto.config,
      });
      void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_CREATED, {
        metadata: { pluginId, instanceId: dto.instanceId },
      });
      return this.view(inst, routes, /* reveal */ true);
    } catch (err) {
      if (err instanceof InstanceExistsError) throw new ConflictException(err.message);
      throw err;
    }
  }

  @Get()
  async list(@Param('pluginId') pluginId: string): Promise<InstanceView[]> {
    const routes = this.pluginRoutes(pluginId);
    const rows = await this.instances.list(pluginId);
    return rows.map(r => this.view(r, routes, false));
  }

  @Get(':instanceId')
  async getOne(@Param('pluginId') pluginId: string, @Param('instanceId') instanceId: string): Promise<InstanceView> {
    const inst = await this.instances.resolve(pluginId, instanceId);
    if (!inst) throw new NotFoundException('instance not found');
    return this.view(inst, this.pluginRoutes(pluginId), false);
  }

  @Post(':instanceId/regenerate-secret')
  @HttpCode(200)
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
  async patch(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @Body() dto: UpdateInstanceDto,
  ): Promise<InstanceView> {
    let inst: PluginInstance | null = await this.instances.resolve(pluginId, instanceId);
    if (!inst) throw new NotFoundException('instance not found');
    if (dto.enabled !== undefined) inst = await this.instances.setEnabled(pluginId, instanceId, dto.enabled);
    if (dto.sessionScope !== undefined || dto.config !== undefined) {
      inst = await this.instances.update(pluginId, instanceId, { sessionScope: dto.sessionScope, config: dto.config });
    }
    return this.view(inst as PluginInstance, this.pluginRoutes(pluginId), false);
  }

  @Delete(':instanceId')
  @HttpCode(204)
  async remove(@Param('pluginId') pluginId: string, @Param('instanceId') instanceId: string): Promise<void> {
    const removed = await this.instances.remove(pluginId, instanceId);
    if (!removed) throw new NotFoundException('instance not found');
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

  private view(inst: PluginInstance, routes: string[], reveal: boolean): InstanceView {
    const masked = reveal ? inst : this.instances.maskedView(inst);
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
