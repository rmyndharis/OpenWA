import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaController } from './media.controller';
import { MediaConversionService } from './media-conversion.service';
import { Session } from '../session/entities/session.entity';

@Module({
  // The session row is read for one field: the egress proxy a URL conversion must leave through
  // when the named session has no live engine to take it from.
  imports: [TypeOrmModule.forFeature([Session], 'data')],
  controllers: [MediaController],
  providers: [MediaConversionService],
  exports: [MediaConversionService],
})
export class MediaModule {}
