import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogItem } from './entities/catalog-item.entity';
import { AiCatalogService } from './ai-catalog.service';
import { AiCatalogController } from './ai-catalog.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CatalogItem], 'data')],
  controllers: [AiCatalogController],
  providers: [AiCatalogService],
  exports: [AiCatalogService],
})
export class AiCatalogModule {}
