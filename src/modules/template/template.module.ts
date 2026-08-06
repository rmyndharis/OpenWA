import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template } from './entities/template.entity';
import { TemplateService } from './template.service';
import { TemplateController } from './template.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Template], 'data')],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
