import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { SessionModule } from '../session/session.module';
import { XenwaUser } from './entities/xenwa-user.entity';
import { XenwaSessionAccess } from './entities/xenwa-session-access.entity';
import { XenwaSsoNonce } from './entities/xenwa-sso-nonce.entity';
import { XenwaNumberBilling } from './entities/xenwa-number-billing.entity';
import { XenwaBillingService } from './xenwa-billing.service';
import { XenwaAccessService } from './xenwa-access.service';
import { XenwaService } from './xenwa.service';
import { XenwaController } from './xenwa.controller';
import { XenwaSsoController } from './xenwa-sso.controller';

/**
 * XenWA: XenAI Tech single sign-on and per-account team access on top of the gateway's API keys.
 * Global so the (global) ApiKeyGuard can resolve XenwaAccessService for its per-permission check.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([XenwaUser, XenwaSessionAccess, XenwaSsoNonce, XenwaNumberBilling, ApiKey], 'main'),
    SessionModule,
  ],
  controllers: [XenwaSsoController, XenwaController],
  providers: [XenwaAccessService, XenwaService, XenwaBillingService],
  exports: [XenwaAccessService, XenwaService],
})
export class XenwaModule {}
