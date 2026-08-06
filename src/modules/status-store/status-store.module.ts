import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([StatusUpdate], 'data'), ConfigModule, StorageModule],
  providers: [StatusStoreService],
  exports: [StatusStoreService],
})
export class StatusStoreModule {}
