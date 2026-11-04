import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Header,
  HttpCode,
  HttpStatus,
  HttpException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { PluginsService } from './plugins.service';
import {
  PluginDto,
  PluginConfigDto,
  PluginSessionsDto,
  InstallFromUrlDto,
  PluginActionResponseDto,
  PluginHealthResponseDto,
  PluginCatalogEntryDto,
} from './dto/plugin.dto';
import type { CatalogPlugin } from './catalog';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { PluginUninstallIncompleteError } from '../../core/plugins/plugin-uninstaller';

/** Max accepted upload size for a plugin package (compressed). */
const MAX_PLUGIN_UPLOAD_BYTES = 5 * 1024 * 1024;

/** A lifecycle change to a plugin the boot restore has not finished with, which can outlast the boot wait. */
const RESTORING_CONFLICT = 'The plugin is still being restored after startup; retry shortly';

/** A config or session write that arrives while an uninstall of the same plugin is unloading it. */
const UNINSTALLING_CONFLICT = 'The plugin is being uninstalled; nothing was changed';

@ApiTags('plugins')
@Controller('plugins')
// Plugin installation and lifecycle are deployment-global and execute plugin code as the OpenWA
// process user, so session-restricted keys are fenced off route by route below. The fence is NOT
// applied at class level because @RequireUnscopedKey takes no argument and cannot be opted out of:
// `updateSessions` is fenced too (it overwrites the ENTIRE active set, so a scoped key could delete
// another tenant's activation by sending its own session or []), and `updateSessionConfig` is
// already covered by the guard through its own :sessionId route param.
export class PluginsController {
  constructor(
    private readonly pluginsService: PluginsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One audit row per successful plugin mutation. Plugins run in the gateway process, so which key
   * installed, enabled or reconfigured one is the first thing an investigation needs. Ids, versions and
   * config FIELD NAMES only: a config can carry credentials, and audit metadata is not a credential store.
   */
  private record(action: AuditAction, pluginId: string, extra: Record<string, unknown> = {}, sessionId?: string): void {
    void this.audit.logInfo(action, { sessionId, metadata: { pluginId, ...extra } });
  }

  /** Host of a download URL: enough to tell where code came from, without a credential or token in the query. */
  private static sourceHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return 'unknown';
    }
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'List all plugins' })
  @ApiResponse({ status: 200, description: 'List of all plugins', type: PluginDto, isArray: true })
  findAll(): PluginDto[] {
    return this.pluginsService.findAll();
  }

  @Post('install')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PLUGIN_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  // @ApiConsumes only names the media type; without a body schema the upload this route exists for is
  // invisible in the contract, and a generated client has no parameter to attach the file to.
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'The plugin .zip package' } },
    },
  })
  @ApiOperation({ summary: 'Install a plugin from an uploaded .zip package' })
  @ApiResponse({ status: 201, description: 'Plugin installed', type: PluginDto })
  @ApiResponse({ status: 400, description: 'Invalid package' })
  @ApiResponse({ status: 409, description: 'Plugin already installed' })
  @ApiResponse({ status: 413, description: 'Package exceeds the 5 MB upload limit' })
  async install(@UploadedFile() file: { buffer?: Buffer }): Promise<PluginDto> {
    const plugin = await this.pluginsService.installPackage(file);
    this.record(AuditAction.PLUGIN_INSTALLED, plugin.id, { version: plugin.version, source: 'upload' });
    return plugin;
  }

  @Post('install-url')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Install a plugin by downloading its .zip from a URL (SSRF-guarded)' })
  @ApiResponse({ status: 201, description: 'Plugin installed', type: PluginDto })
  @ApiResponse({ status: 400, description: 'Invalid URL, download failed, or invalid package' })
  @ApiResponse({
    status: 409,
    description: 'Plugin already installed, or the plugin is still being restored after startup; retry shortly',
  })
  async installFromUrl(@Body() dto: InstallFromUrlDto): Promise<PluginDto> {
    const plugin = await this.pluginsService.installFromUrl(dto.url);
    this.record(AuditAction.PLUGIN_INSTALLED, plugin.id, {
      version: plugin.version,
      source: PluginsController.sourceHost(dto.url),
    });
    return plugin;
  }

  // Declared before `:id` so `GET /plugins/catalog` is not captured by the `:id` route.
  @Get('catalog')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'List the remote plugin catalog, annotated with install state' })
  @ApiResponse({ status: 200, description: 'Catalog entries', type: [PluginCatalogEntryDto] })
  @ApiResponse({ status: 400, description: 'Catalog could not be fetched or parsed' })
  async catalog(): Promise<CatalogPlugin[]> {
    return await this.pluginsService.getCatalog();
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Get plugin by ID' })
  @ApiResponse({ status: 200, description: 'Plugin details', type: PluginDto })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  findOne(@Param('id') id: string): PluginDto {
    return this.pluginsService.findOne(id);
  }

  @Post(':id/enable')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a plugin' })
  @ApiResponse({ status: 200, description: 'Plugin enabled successfully', type: PluginActionResponseDto })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: RESTORING_CONFLICT })
  async enable(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    const result = await this.pluginsService.enable(id);
    if (result.success) this.record(AuditAction.PLUGIN_ENABLED, id);
    return result;
  }

  @Post(':id/disable')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a plugin' })
  @ApiResponse({ status: 200, description: 'Plugin disabled successfully', type: PluginActionResponseDto })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: RESTORING_CONFLICT })
  async disable(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    const result = await this.pluginsService.disable(id);
    if (result.success) this.record(AuditAction.PLUGIN_DISABLED, id);
    return result;
  }

  @Put(':id/config')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Update plugin configuration' })
  @ApiResponse({ status: 200, description: 'Plugin configuration updated', type: PluginActionResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: UNINSTALLING_CONFLICT })
  updateConfig(@Param('id') id: string, @Body() configDto: PluginConfigDto): { success: boolean; message: string } {
    const result = this.pluginsService.updateConfig(id, configDto.config);
    // The service answers a refused change with 200 and success false, so a row is written only for one applied.
    if (result.success)
      this.record(AuditAction.PLUGIN_CONFIG_UPDATED, id, { fields: Object.keys(configDto.config ?? {}) });
    return result;
  }

  // The dashboard fetches this WITH the API key and injects the body as an opaque-origin sandboxed
  // iframe srcdoc. It attaches that document's response-specific nonce to inline scripts so the
  // inherited CSP allows only the isolated editor bootstrap, without enabling parent unsafe-inline.
  @Get(':id/config-ui')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', 'sandbox')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: "Serve a plugin's sandboxed config-UI entry HTML (for an iframe srcdoc)" })
  // The handler pins the media type with @Header, which the document cannot see — declare it, or the
  // only HTML route in the API publishes a 200 a client would decode as JSON.
  @ApiResponse({
    status: 200,
    description: 'Config UI HTML',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 404, description: 'Plugin not found or has no config UI' })
  getConfigUi(@Param('id') id: string): string {
    return this.pluginsService.getConfigUiHtml(id);
  }

  @Put(':id/config/:sessionId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Set a plugin config override for a specific session (empty = clear it)' })
  @ApiResponse({ status: 200, description: 'Per-session plugin configuration updated', type: PluginActionResponseDto })
  @ApiResponse({ status: 400, description: 'Plugin is global (not session-scoped), or the body failed validation' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: UNINSTALLING_CONFLICT })
  updateSessionConfig(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() configDto: PluginConfigDto,
  ): { success: boolean; message: string } {
    const result = this.pluginsService.updateSessionConfig(id, sessionId, configDto.config);
    if (result.success) {
      this.record(AuditAction.PLUGIN_CONFIG_UPDATED, id, { fields: Object.keys(configDto.config ?? {}) }, sessionId);
    }
    return result;
  }

  @Put(':id/sessions')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: "Set which sessions a session-scoped plugin is activated for (['*'] = all)" })
  @ApiResponse({ status: 200, description: 'Plugin session activation updated', type: PluginDto })
  @ApiResponse({ status: 400, description: 'Plugin is global (not session-scoped), or the body failed validation' })
  @ApiResponse({
    status: 403,
    description:
      'A session-restricted key may not replace the full active set — full activation replacement requires an unrestricted key',
  })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: UNINSTALLING_CONFLICT })
  @ApiResponse({ status: 500, description: 'The plugin registry could not be written; nothing was changed' })
  updateSessions(@Param('id') id: string, @Body() dto: PluginSessionsDto): PluginDto {
    // This is a full-replacement PUT (setPluginSessions overwrites the entire activeSessions array),
    // so a scoped key must never reach it: sending [] or its own session would delete every other
    // tenant's activation. The @RequireUnscopedKey fence above enforces that before the handler runs.
    const plugin = this.pluginsService.updateSessions(id, dto.sessions);
    this.record(AuditAction.PLUGIN_SESSIONS_UPDATED, id, { sessions: dto.sessions });
    return plugin;
  }

  @Post(':id/update')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Update an installed plugin in place from a URL (preserves config + enabled state)' })
  @ApiResponse({ status: 201, description: 'Plugin updated', type: PluginDto })
  @ApiResponse({ status: 400, description: 'Invalid URL/package, id mismatch, or built-in' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: RESTORING_CONFLICT })
  @ApiResponse({
    status: 503,
    description: 'Gateway shutting down; the previous version was kept',
  })
  async update(@Param('id') id: string, @Body() dto: InstallFromUrlDto): Promise<PluginDto> {
    const plugin = await this.pluginsService.updateFromUrl(id, dto.url);
    this.record(AuditAction.PLUGIN_UPDATED, id, {
      version: plugin.version,
      source: PluginsController.sourceHost(dto.url),
    });
    return plugin;
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Uninstall a plugin (removes its files; built-ins are protected)' })
  @ApiResponse({ status: 200, description: 'Plugin uninstalled', type: PluginActionResponseDto })
  @ApiResponse({ status: 400, description: 'Cannot uninstall (e.g. built-in)' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  @ApiResponse({ status: 409, description: RESTORING_CONFLICT })
  @ApiResponse({ status: 500, description: 'The plugin registry could not be written; nothing was removed' })
  async uninstall(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    const result = await this.pluginsService.uninstall(id).catch((error: unknown) => {
      // A 400 raised after the entry was stored emptied has already erased the plugin's config and stopped it;
      // a refusal (built-in, unwritable registry) changed nothing and leaves no row.
      if (error instanceof HttpException && error.cause instanceof PluginUninstallIncompleteError) {
        this.record(AuditAction.PLUGIN_UNINSTALLED, id, { partial: true, error: error.message });
      }
      throw error;
    });
    this.record(AuditAction.PLUGIN_UNINSTALLED, id);
    return result;
  }

  @Get(':id/health')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Check plugin health' })
  @ApiResponse({ status: 200, description: 'Plugin health status', type: PluginHealthResponseDto })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  async healthCheck(@Param('id') id: string): Promise<{ healthy: boolean; message?: string }> {
    return await this.pluginsService.healthCheck(id);
  }
}
