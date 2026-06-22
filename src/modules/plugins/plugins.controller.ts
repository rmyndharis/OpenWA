import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { PluginsService } from './plugins.service';
import { PluginDto, PluginConfigDto } from './dto/plugin.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/** Max accepted upload size for a plugin package (compressed). */
const MAX_PLUGIN_UPLOAD_BYTES = 5 * 1024 * 1024;

@ApiTags('plugins')
@Controller('plugins')
export class PluginsController {
  constructor(private readonly pluginsService: PluginsService) {}

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List all plugins' })
  @ApiResponse({ status: 200, description: 'List of all plugins' })
  findAll(): PluginDto[] {
    return this.pluginsService.findAll();
  }

  @Post('install')
  @RequireRole(ApiKeyRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PLUGIN_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Install a plugin from an uploaded .zip package' })
  @ApiResponse({ status: 201, description: 'Plugin installed' })
  @ApiResponse({ status: 400, description: 'Invalid package' })
  @ApiResponse({ status: 409, description: 'Plugin already installed' })
  install(@UploadedFile() file: { buffer?: Buffer }): PluginDto {
    return this.pluginsService.install(file);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get plugin by ID' })
  @ApiResponse({ status: 200, description: 'Plugin details' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  findOne(@Param('id') id: string): PluginDto {
    return this.pluginsService.findOne(id);
  }

  @Post(':id/enable')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a plugin' })
  @ApiResponse({ status: 200, description: 'Plugin enabled successfully' })
  async enable(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    return await this.pluginsService.enable(id);
  }

  @Post(':id/disable')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a plugin' })
  @ApiResponse({ status: 200, description: 'Plugin disabled successfully' })
  async disable(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    return await this.pluginsService.disable(id);
  }

  @Put(':id/config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update plugin configuration' })
  @ApiResponse({ status: 200, description: 'Plugin configuration updated' })
  updateConfig(@Param('id') id: string, @Body() configDto: PluginConfigDto): { success: boolean; message: string } {
    return this.pluginsService.updateConfig(id, configDto.config);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Uninstall a plugin (removes its files; built-ins are protected)' })
  @ApiResponse({ status: 200, description: 'Plugin uninstalled' })
  @ApiResponse({ status: 400, description: 'Cannot uninstall (e.g. built-in)' })
  @ApiResponse({ status: 404, description: 'Plugin not found' })
  async uninstall(@Param('id') id: string): Promise<{ success: boolean; message: string }> {
    return await this.pluginsService.uninstall(id);
  }

  @Get(':id/health')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Check plugin health' })
  @ApiResponse({ status: 200, description: 'Plugin health status' })
  async healthCheck(@Param('id') id: string): Promise<{ healthy: boolean; message?: string }> {
    return await this.pluginsService.healthCheck(id);
  }
}
