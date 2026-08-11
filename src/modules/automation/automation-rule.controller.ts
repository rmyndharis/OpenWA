import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationRuleResponseDto, CreateAutomationRuleDto, UpdateAutomationRuleDto } from './dto/automation-rule.dto';

@ApiTags('automation')
@Controller('sessions/:sessionId/automation-rules')
export class AutomationRuleController {
  constructor(private readonly automationRules: AutomationRulesService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create an autoreply rule' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Rule created.', type: AutomationRuleResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid rule (bad conditions, over-limit text).' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateAutomationRuleDto,
  ): Promise<AutomationRuleResponseDto> {
    return AutomationRuleResponseDto.fromEntity(await this.automationRules.create(sessionId, dto));
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List the session’s autoreply rules' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Rules in evaluation order: creation time, id as the same-second tiebreak.',
    type: AutomationRuleResponseDto,
    isArray: true,
  })
  async findAll(@Param('sessionId') sessionId: string): Promise<AutomationRuleResponseDto[]> {
    return (await this.automationRules.findAll(sessionId)).map(rule => AutomationRuleResponseDto.fromEntity(rule));
  }

  @Get(':ruleId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get one autoreply rule' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'ruleId', description: 'Rule ID' })
  @ApiResponse({ status: 200, description: 'The rule.', type: AutomationRuleResponseDto })
  @ApiResponse({ status: 404, description: 'No such rule in this session.' })
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('ruleId') ruleId: string,
  ): Promise<AutomationRuleResponseDto> {
    return AutomationRuleResponseDto.fromEntity(await this.automationRules.findOne(sessionId, ruleId));
  }

  @Put(':ruleId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update an autoreply rule' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'ruleId', description: 'Rule ID' })
  @ApiResponse({ status: 200, description: 'Updated rule.', type: AutomationRuleResponseDto })
  @ApiResponse({ status: 404, description: 'No such rule in this session.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateAutomationRuleDto,
  ): Promise<AutomationRuleResponseDto> {
    return AutomationRuleResponseDto.fromEntity(await this.automationRules.update(sessionId, ruleId, dto));
  }

  @Delete(':ruleId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an autoreply rule' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'ruleId', description: 'Rule ID' })
  @ApiResponse({ status: 204, description: 'Rule deleted.' })
  @ApiResponse({ status: 404, description: 'No such rule in this session.' })
  async remove(@Param('sessionId') sessionId: string, @Param('ruleId') ruleId: string): Promise<void> {
    await this.automationRules.remove(sessionId, ruleId);
  }
}
