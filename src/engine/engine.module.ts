import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMapping } from './identity/lid-mapping.entity';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatState } from './adapters/baileys-chat-state.entity';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { StoredChatPreviewService } from './adapters/baileys-stored-chat-previews.service';
import { Message } from '../modules/message/entities/message.entity';
import { EngineRegistry } from './engine-registry.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BaileysStoredMessage, LidMapping, ChatState, Message], 'data')],
  // EngineRegistry is exported from this @Global module so the feature services that only need a
  // live engine can inject it directly, instead of importing SessionModule to reach the lifecycle
  // owner. It is a singleton by DI, which is what makes it a safe single source of truth.
  providers: [
    EngineFactory,
    BaileysMessageStoreService,
    LidMappingStoreService,
    ChatStateStoreService,
    StoredChatPreviewService,
    EngineRegistry,
  ],
  exports: [EngineFactory, LidMappingStoreService, ChatStateStoreService, EngineRegistry],
})
export class EngineModule {}
