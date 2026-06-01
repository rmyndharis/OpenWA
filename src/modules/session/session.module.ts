import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { SessionRegistry } from './session-registry.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data'), forwardRef(() => WebhookModule)],
  controllers: [SessionController],
  providers: [SessionService, SessionRegistry],
  exports: [SessionService, SessionRegistry],
})
export class SessionModule {}
