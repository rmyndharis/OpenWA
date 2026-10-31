import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsString, IsUrl } from 'class-validator';
import type { PluginConfigSchema, PluginI18n } from '../../../core/plugins';
import { PluginType, PluginStatus } from '../../../core/plugins';
import { ToStrictArray, ToStrictString } from '../../../common/utils/strict-boolean';

export class PluginDto {
  @ApiProperty({ description: 'Plugin ID' })
  id!: string;

  @ApiProperty({ description: 'Plugin name' })
  name!: string;

  @ApiProperty({ description: 'Plugin version' })
  version!: string;

  @ApiProperty({ enum: PluginType, description: 'Plugin type' })
  type!: PluginType;

  @ApiPropertyOptional({ description: 'Plugin description' })
  description?: string;

  @ApiPropertyOptional({ description: 'Plugin author' })
  author?: string;

  @ApiProperty({ enum: PluginStatus, description: 'Plugin status' })
  status!: PluginStatus;

  @ApiProperty({ description: 'Plugin configuration' })
  config!: Record<string, unknown>;

  @ApiProperty({ description: 'Whether this is a built-in plugin' })
  builtIn!: boolean;

  @ApiProperty({ description: 'Features provided by this plugin' })
  provides!: string[];

  @ApiProperty({ description: 'Whether this plugin can host provisioned ingress instances' })
  ingressCapable!: boolean;

  @ApiProperty({ description: 'Whether the plugin is scoped to specific sessions (false = global)' })
  sessionScoped!: boolean;

  @ApiProperty({ description: "Sessions this plugin is activated for; ['*'] = all numbers" })
  activeSessions!: string[];

  @ApiPropertyOptional({ description: 'Configuration schema' })
  configSchema?: PluginConfigSchema;

  @ApiPropertyOptional({ description: 'Sandboxed-iframe config editor (entry HTML + optional height)' })
  configUi?: { entry: string; height?: number };

  @ApiPropertyOptional({ description: 'Localized dashboard text (name/description/config titles) per locale code' })
  i18n?: PluginI18n;

  @ApiPropertyOptional({ description: 'Per-session config overrides, keyed by sessionId (secrets redacted)' })
  sessionConfig?: Record<string, Record<string, unknown>>;

  @ApiPropertyOptional({ description: 'When the plugin was loaded' })
  loadedAt?: string;

  @ApiPropertyOptional({ description: 'When the plugin was enabled' })
  enabledAt?: string;

  @ApiPropertyOptional({ description: 'Error message if plugin is in error state' })
  error?: string;
}

export class PluginConfigDto {
  @ApiProperty({ description: 'Plugin configuration object' })
  @IsObject()
  config!: Record<string, unknown>;
}

export class PluginSessionsDto {
  @ApiProperty({
    description: "Sessions to activate the plugin for; ['*'] = all numbers, [] = none",
    example: ['*'],
    type: [String],
  })
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  sessions!: string[];
}

export class InstallFromUrlDto {
  @ApiProperty({
    description:
      'URL of the plugin .zip to download and install (SSRF-guarded; private-network hosts remain ' +
      'subject to the guard). https:// is accepted without a pin, except that NODE_ENV=production (the ' +
      'Docker image default) requires the `#sha256=` pin described below on every URL unless ' +
      'PLUGIN_INSTALL_REQUIRE_PIN=false, and PLUGIN_INSTALL_REQUIRE_PIN=true requires it everywhere. ' +
      'Plain http:// is only accepted when the URL ' +
      'pins the package content — append `#sha256=<64 hex>` (fragment — never sent to the server; query ' +
      'params are ignored) — because the package is executable code and must be integrity-protected in ' +
      'transit. A pinned digest that does not match the downloaded archive fails the install.',
  })
  @ToStrictString()
  @IsString()
  // require_tld:false + allow_underscores:true so single-label hosts (a compose service, `localhost`) reach
  // the SSRF guard, which admits them only when SSRF_ALLOWED_HOSTS names them.
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false, allow_underscores: true },
    { message: 'url must be an absolute http(s) URL' },
  )
  url!: string;
}

/** Shared shape of the plugin lifecycle writes (enable/disable/config/uninstall). */
export class PluginActionResponseDto {
  @ApiProperty({ description: 'Whether the change was applied; a refusal is carried in `message`.', example: true })
  success!: boolean;

  @ApiProperty({ description: 'Human-readable outcome.', example: 'Plugin echo configuration updated' })
  message!: string;
}

export class PluginHealthResponseDto {
  @ApiProperty({ description: 'Whether the plugin reports healthy.', example: true })
  healthy!: boolean;

  @ApiPropertyOptional({ description: 'Failure detail when unhealthy.', example: 'worker did not answer in time' })
  message?: string;
}

/** A remote-catalog entry annotated with this instance's install state. Extra catalog fields pass through. */
export class PluginCatalogEntryDto {
  @ApiProperty({ example: 'echo' })
  id!: string;

  @ApiProperty({ example: 'Echo Bot' })
  name!: string;

  @ApiProperty({ example: '1.2.0' })
  version!: string;

  @ApiPropertyOptional({ example: 'utility' })
  type?: string;

  @ApiPropertyOptional({ example: 'stable' })
  status?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  author?: string;

  @ApiPropertyOptional({ example: 'MIT' })
  license?: string;

  @ApiPropertyOptional({ type: [String] })
  keywords?: string[];

  @ApiPropertyOptional({ example: '0.18.0' })
  minOpenWAVersion?: string;

  @ApiPropertyOptional({ example: '0.18.0' })
  testedOpenWAVersion?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  releasedAt?: string;

  @ApiPropertyOptional({ example: 'https://github.com/example/echo-plugin' })
  repoUrl?: string;

  @ApiPropertyOptional()
  homepage?: string;

  @ApiPropertyOptional({ description: 'Download URL of the plugin package.' })
  download?: string;

  @ApiProperty({ description: 'Whether this instance has the plugin installed.', example: false })
  installed!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The installed version, or null when not installed.',
    example: null,
  })
  installedVersion!: string | null;

  @ApiProperty({ description: 'True when installed and the catalog version is strictly newer.', example: false })
  updateAvailable!: boolean;
}
