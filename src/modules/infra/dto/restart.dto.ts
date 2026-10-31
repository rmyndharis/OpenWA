import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { ToStrictArray } from '../../../common/utils/strict-boolean';

/** Body for POST /infra/restart. */
export class RestartDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  profiles?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  profilesToRemove?: string[];
}
