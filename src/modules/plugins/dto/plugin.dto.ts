import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsString, IsUrl } from 'class-validator';
import type { PluginConfigSchema, PluginI18n } from '../../../core/plugins';
import { PluginType, PluginStatus } from '../../../core/plugins';

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
  @IsArray()
  @IsString({ each: true })
  sessions!: string[];
}

export class InstallFromUrlDto {
  @ApiProperty({ description: 'HTTP(S) URL of the plugin .zip to download and install' })
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  url!: string;
}
