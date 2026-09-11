import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientMapping } from './entities/client-mapping.entity';
import { ClientMappingService } from './client-mapping.service';
import { ClientMappingIdentityService } from './client-mapping-identity.service';
import { ClientMappingAutoTagService } from './client-mapping-auto-tag.service';
import { ClientMappingController } from './client-mapping.controller';

@Module({
  // EngineRegistry/LidMappingStoreService (ClientMappingIdentityService's collaborators) come from
  // the @Global() EngineModule — no explicit import needed, and importing SessionModule here would
  // be circular (SessionModule already imports ClientMappingModule; see session.module.ts).
  imports: [TypeOrmModule.forFeature([ClientMapping], 'data')],
  controllers: [ClientMappingController],
  providers: [ClientMappingService, ClientMappingIdentityService, ClientMappingAutoTagService],
  exports: [ClientMappingService, ClientMappingAutoTagService],
})
export class ClientMappingModule {}
