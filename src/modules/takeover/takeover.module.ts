import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { MessageModule } from '../message/message.module';
import { SessionTakeoverService } from './session-takeover.service';

/**
 * Sits ABOVE both SessionModule and MessageModule on purpose: the takeover sweep starts sessions
 * (SessionService) and reconciles their bulk batches (BulkMessageService), and MessageModule
 * already imports SessionModule — so this is the lowest place both are reachable without a cycle.
 */
@Module({
  imports: [SessionModule, MessageModule],
  providers: [SessionTakeoverService],
})
export class TakeoverModule {}
