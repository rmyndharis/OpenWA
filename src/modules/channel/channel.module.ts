import { Module } from '@nestjs/common';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';

@Module({
  controllers: [ChannelController],
  providers: [ChannelService],
})
export class ChannelModule {}
