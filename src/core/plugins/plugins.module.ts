import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { ConversationMapping } from '../../modules/integration/entities/conversation-mapping.entity';
import { ConversationMappingService } from '../../modules/integration/conversation-mapping.service';

@Global() // Make plugin services available everywhere
@Module({
  imports: [TypeOrmModule.forFeature([ConversationMapping], 'data')],
  // ConversationMappingService is resolved lazily (ModuleRef) by PluginLoaderService, the same
  // pattern used for MessageService/SessionService, to avoid a static import edge back into this
  // module's graph — so it only needs to be a provider here, not re-exported.
  providers: [PluginStorageService, PluginLoaderService, ConversationMappingService],
  exports: [PluginLoaderService, PluginStorageService],
})
export class PluginsModule {}
