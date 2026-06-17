import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { TranslationGroup } from './entities/translation-group.entity';
import { TranslationHook } from './translation.hook';
import { TranslationCoordinator, CoordinatorOptions } from './core/translation.coordinator';
import { LibreTranslateClient } from './adapters/libretranslate.client';
import { TypeOrmConfigStore } from './adapters/typeorm-config.store';
import { OpenWaChatGateway } from './adapters/openwa-chat.gateway';
import { MessageModule } from '../message/message.module';
import { MessageService } from '../message/message.service';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';

@Module({
  imports: [TypeOrmModule.forFeature([TranslationGroup], 'data'), ConfigModule, MessageModule, SessionModule],
  providers: [
    {
      provide: TranslationCoordinator,
      inject: [ConfigService, getRepositoryToken(TranslationGroup, 'data'), MessageService, SessionService],
      useFactory: (
        config: ConfigService,
        repo: Repository<TranslationGroup>,
        messageService: MessageService,
        sessionService: SessionService,
      ) => {
        const translator = new LibreTranslateClient({
          url: config.get<string>('translation.libretranslateUrl', 'http://localhost:7001'),
          apiKey: config.get<string>('translation.libretranslateApiKey'),
          timeoutMs: config.get<number>('translation.timeoutMs', 5000),
        });
        const store = new TypeOrmConfigStore(repo);
        const gateway = new OpenWaChatGateway(messageService, sessionService);
        const opts: CoordinatorOptions = {
          prefix: config.get<string>('translation.commandPrefix', '/tr'),
          minLength: config.get<number>('translation.minLength', 2),
          maxLength: config.get<number>('translation.maxLength', 2000),
          denyReply: config.get<boolean>('translation.denyReply', false),
        };
        return new TranslationCoordinator(translator, store, gateway, opts);
      },
    },
    TranslationHook,
  ],
})
export class TranslationModule {}
