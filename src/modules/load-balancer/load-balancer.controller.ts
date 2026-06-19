import { Controller, Get, Post, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoadBalancerService } from './load-balancer.service';
import { SessionService } from '../session/session.service';
import { MessageService } from '../message/message.service';
import { SessionStatus } from '../session/entities/session.entity';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

class SendBalancedDto {
  @ApiProperty({ description: 'WhatsApp chat ID', example: '628123456789@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Text message', example: 'Hello!', maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;

  @ApiPropertyOptional({ description: 'Override session selection (bypasses load balancer)' })
  @IsOptional()
  @IsString()
  sessionId?: string;
}

class SetEnabledDto {
  enabled: boolean;
}

@ApiTags('load-balancer')
@Controller('sessions/load-balancer')
export class LoadBalancerController {
  constructor(
    private readonly lb: LoadBalancerService,
    private readonly sessionService: SessionService,
  ) {}

  @Get('scores')
  @ApiOperation({ summary: 'Current Thompson Sampling scores per session' })
  async getScores() {
    const [scores, daily] = await Promise.all([this.lb.getScores(), this.lb.getDailyStats()]);
    return { scores, daily, enabled: this.lb.isEnabled() };
  }

  @Post('reset')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Reset all Thompson Sampling scores' })
  async reset() {
    await this.lb.resetScores();
    return { success: true };
  }

  @Post('enabled')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Enable or disable load balancing globally' })
  async setEnabled(@Body() dto: SetEnabledDto) {
    await this.lb.setEnabled(dto.enabled);
    return { enabled: dto.enabled };
  }
}

@ApiTags('messages')
@Controller('messages/send-balanced')
export class SendBalancedController {
  constructor(
    private readonly lb: LoadBalancerService,
    private readonly sessionService: SessionService,
    private readonly messageService: MessageService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Send a message via auto-selected session (Thompson Sampling)' })
  @ApiResponse({ status: 200, description: 'Message sent' })
  async sendBalanced(@Body() dto: SendBalancedDto) {
    let sessionId = dto.sessionId;

    if (!sessionId) {
      const allSessions = await this.sessionService.findAll();
      const readySessions = allSessions
        .filter(s => s.status === SessionStatus.READY)
        .map(s => s.id);

      if (readySessions.length === 0) {
        throw new BadRequestException('No ready sessions available for load balancing');
      }

      sessionId = await this.lb.selectSession(readySessions);
    }

    try {
      const result = await this.messageService.sendText(sessionId, { chatId: dto.chatId, text: dto.text });
      await this.lb.recordOutcome(sessionId, true);
      return { ...result, sessionId };
    } catch (error) {
      await this.lb.recordOutcome(sessionId, false);
      throw error;
    }
  }
}
