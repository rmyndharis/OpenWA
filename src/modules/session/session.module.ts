import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { SessionRegistry } from './session-registry.service';
import { SessionController } from './session.controller';

// SessionService no longer depends on WebhookService/EventsGateway directly —
// it emits domain events (session.events.ts) that those services subscribe to
// via @OnEvent, so the former forwardRef(WebhookModule) coupling is gone.
@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data')],
  controllers: [SessionController],
  providers: [SessionService, SessionRegistry],
  exports: [SessionService, SessionRegistry],
})
export class SessionModule {}
