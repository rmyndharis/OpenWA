import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { BrowserSession } from './entities/browser-session.entity';
import { AuthService } from './auth.service';
import { BrowserSessionService } from './browser-session.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { BrowserSessionController } from './browser-session.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, BrowserSession], 'main')],
  controllers: [AuthController, AuthValidateController, BrowserSessionController],
  providers: [
    AuthService,
    BrowserSessionService,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, BrowserSessionService, ChatScopeService, ActiveKeyIndex],
})
export class AuthModule {}
