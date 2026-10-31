import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';

/**
 * Body for PUT /infra/config (saveConfig). Every section is optional: an absent section leaves the
 * stored keys for that section untouched, and within a section an absent field leaves its stored
 * key untouched — a partial payload only changes what it explicitly carries.
 *
 * Booleans use @ToStrictBoolean (and poolSize @ToStrictNumber) because the global ValidationPipe
 * runs with enableImplicitConversion: a form-encoded body delivers scalars as strings, and
 * class-transformer's implicit cast turns ANY non-empty string — including 'false' — into `true`
 * before @IsBoolean() ever runs. Without the strict transform, saving the Infrastructure form
 * URL-encoded would persist 'true' for every unchecked toggle. Only 'true'/'false'/real booleans
 * are accepted; any other spelling is rejected 400.
 */
export class DatabaseConfigDto {
  @ApiPropertyOptional({
    enum: ['sqlite', 'postgres'],
    description:
      'Absent keeps the stored selection, which the rest of the section then applies to. While the environment pins ' +
      'another selection than the stored one, a section without it writes nothing.',
  })
  @IsOptional()
  @IsIn(['sqlite', 'postgres'])
  type?: 'sqlite' | 'postgres';

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  host?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  port?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  database?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  schema?: string;

  @ApiPropertyOptional()
  @ToStrictNumber()
  @IsOptional()
  @IsNumber()
  poolSize?: number;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  sslEnabled?: boolean;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  sslRejectUnauthorized?: boolean;
}

export class RedisConfigDto {
  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  host?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  port?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  password?: string;
}

export class QueueConfigDto {
  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class StorageConfigDto {
  @ApiPropertyOptional({
    enum: ['local', 's3'],
    description:
      'Absent keeps the stored selection, which the rest of the section then applies to. While the environment pins ' +
      'another selection than the stored one, a section without it writes nothing.',
  })
  @IsOptional()
  @IsIn(['local', 's3'])
  type?: 'local' | 's3';

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  builtIn?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  localPath?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  s3Bucket?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  s3Region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  s3AccessKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  s3SecretKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  s3Endpoint?: string;
}

export class EngineConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  headless?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  sessionDataPath?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  browserArgs?: string;
}

export class SaveConfigDto {
  @ApiPropertyOptional({ type: () => DatabaseConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DatabaseConfigDto)
  database?: DatabaseConfigDto;

  @ApiPropertyOptional({ type: () => RedisConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RedisConfigDto)
  redis?: RedisConfigDto;

  @ApiPropertyOptional({ type: () => QueueConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QueueConfigDto)
  queue?: QueueConfigDto;

  @ApiPropertyOptional({ type: () => StorageConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StorageConfigDto)
  storage?: StorageConfigDto;

  @ApiPropertyOptional({ type: () => EngineConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EngineConfigDto)
  engine?: EngineConfigDto;
}
