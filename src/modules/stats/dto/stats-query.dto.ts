import { IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class StatsQueryDto {
  // The Nest swagger CLI plugin is not enabled for this project, so a class-validator decorator alone
  // publishes nothing: without @ApiPropertyOptional the operation ships `parameters: []` and the window
  // selector is invisible to every client reading the contract.
  @ApiPropertyOptional({
    description: 'Time window for the returned series.',
    enum: ['24h', '7d', '30d'],
    default: '24h',
  })
  @IsOptional()
  @IsIn(['24h', '7d', '30d'])
  period?: '24h' | '7d' | '30d' = '24h';
}
