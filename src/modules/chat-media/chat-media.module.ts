import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Message } from '../message/entities/message.entity';
import { ChatMediaArchiveService } from './chat-media-archive.service';
import { StorageModule } from '../../common/storage/storage.module';

/**
 * Standalone so both consumers can reach the archive without a cycle: SessionModule writes to it
 * from the inbound projector, MessageModule reads from it for the media endpoint, and MessageModule
 * already imports SessionModule. Mirrors StatusStoreModule, which sits in the same position.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Message], 'data'), ConfigModule, StorageModule],
  providers: [ChatMediaArchiveService],
  exports: [ChatMediaArchiveService],
})
export class ChatMediaModule {}
