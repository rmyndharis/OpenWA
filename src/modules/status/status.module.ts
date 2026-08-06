import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';
import { StatusStoreModule } from '../status-store/status-store.module';

@Module({
  imports: [MessageModule, StatusStoreModule],
  controllers: [StatusController],
  providers: [StatusService],
  exports: [StatusService],
})
export class StatusModule {}
