import { Module } from '@nestjs/common';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  controllers: [CallController],
  providers: [CallService],
  exports: [CallService],
})
export class CallModule {}
