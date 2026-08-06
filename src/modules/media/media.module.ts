import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaConversionService } from './media-conversion.service';

@Module({
  controllers: [MediaController],
  providers: [MediaConversionService],
  exports: [MediaConversionService],
})
export class MediaModule {}
