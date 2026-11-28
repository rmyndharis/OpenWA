import { Controller, Get, Post, Put, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TemplateService } from './template.service';
import { CreateTemplateDto, UpdateTemplateDto, TemplateResponseDto } from './dto';
import { Template } from './entities/template.entity';
import { Capability, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyCapability } from '../auth/api-key-permissions';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('templates')
@Controller('sessions/:sessionId/templates')
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Capability(ApiKeyCapability.TEMPLATES_WRITE)
  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a message template for the session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Template created', type: TemplateResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 409, description: 'A template with that name already exists for the session' })
  async create(@Param('sessionId') sessionId: string, @Body() dto: CreateTemplateDto): Promise<Template> {
    return this.templateService.create(sessionId, dto);
  }

  @Capability(ApiKeyCapability.TEMPLATES_READ)
  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all templates for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of templates', type: [TemplateResponseDto] })
  async findBySession(@Param('sessionId') sessionId: string): Promise<Template[]> {
    return this.templateService.findBySession(sessionId);
  }

  @Capability(ApiKeyCapability.TEMPLATES_READ)
  @Get(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get a template by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template details', type: TemplateResponseDto })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<Template> {
    return this.templateService.findOne(sessionId, id);
  }

  @Capability(ApiKeyCapability.TEMPLATES_WRITE)
  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a template' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template updated', type: TemplateResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'A template with that name already exists for the session' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<Template> {
    return this.templateService.update(sessionId, id, dto);
  }

  @Capability(ApiKeyCapability.TEMPLATES_WRITE)
  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a template' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 204, description: 'Template deleted' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async delete(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<void> {
    return this.templateService.delete(sessionId, id);
  }
}
