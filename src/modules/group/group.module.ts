import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

@Module({
  imports: [MessageModule],
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
