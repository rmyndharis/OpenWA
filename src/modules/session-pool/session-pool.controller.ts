import { Controller, Get, Post, Put, Delete, Param, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsInt, IsArray, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SessionPoolService } from './session-pool.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

class CreatePoolDto {
  @ApiProperty() @IsString() @IsNotEmpty() name: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10) targetStandbyCount?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() productionSessionIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() standbySessionIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoFailover?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(300) standbyWarmupSeconds?: number;
}

class UpdatePoolDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10) targetStandbyCount?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() productionSessionIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() standbySessionIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoFailover?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(300) standbyWarmupSeconds?: number;
}

@ApiTags('session-pools')
@Controller('session-pools')
export class SessionPoolController {
  constructor(private readonly poolService: SessionPoolService) {}

  @Get()
  @ApiOperation({ summary: 'List all session pools' })
  async findAll() {
    const pools = await this.poolService.findAll();
    return pools.map(p => ({
      ...p,
      productionSessionIds: JSON.parse(p.productionSessionIds) as string[],
      standbySessionIds: JSON.parse(p.standbySessionIds) as string[],
    }));
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a session pool' })
  async create(@Body() dto: CreatePoolDto) {
    return this.poolService.create(dto);
  }

  @Put(':poolId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a session pool' })
  @ApiParam({ name: 'poolId' })
  async update(@Param('poolId') poolId: string, @Body() dto: UpdatePoolDto) {
    return this.poolService.update(poolId, dto);
  }

  @Delete(':poolId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Delete a session pool' })
  @ApiParam({ name: 'poolId' })
  async remove(@Param('poolId') poolId: string) {
    await this.poolService.remove(poolId);
    return { success: true };
  }

  @Get(':poolId/status')
  @ApiOperation({ summary: 'Pool health — production + standby session statuses' })
  @ApiParam({ name: 'poolId' })
  async getStatus(@Param('poolId') poolId: string) {
    const status = await this.poolService.getPoolStatus(poolId);
    return {
      ...status,
      pool: {
        ...status.pool,
        productionSessionIds: JSON.parse(status.pool.productionSessionIds) as string[],
        standbySessionIds: JSON.parse(status.pool.standbySessionIds) as string[],
      },
      failoverHistory: this.poolService.getFailoverHistory().filter(r => r.poolId === poolId),
    };
  }

  @Post(':poolId/failover-test')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Simulate failover for a production session (dev only)' })
  @ApiParam({ name: 'poolId' })
  async failoverTest(@Param('poolId') poolId: string, @Body() body: { sessionId: string }) {
    if (!body.sessionId) throw new BadRequestException('sessionId required');
    const promotedId = await this.poolService.failover(body.sessionId);
    return { success: true, promotedSessionId: promotedId };
  }

  @Get('failover-history')
  @ApiOperation({ summary: 'Recent failover history across all pools' })
  async getHistory() {
    return this.poolService.getFailoverHistory();
  }
}
