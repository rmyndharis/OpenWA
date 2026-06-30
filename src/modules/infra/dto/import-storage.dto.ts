import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/**
 * Body for POST /infra/storage/import. A class (not an inline object literal) so the global
 * ValidationPipe's whitelist/forbidNonWhitelisted actually runs — rejecting a non-string or extra
 * property before the handler's data-directory path check.
 */
export class ImportStorageDto {
  @ApiProperty({ description: 'Path to the tar.gz file to import (must be inside the data directory)' })
  @IsString()
  @IsNotEmpty()
  filePath: string;
}
