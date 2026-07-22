import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './entities/message.entity';
import { MessageAnnotation } from './entities/message-annotation.entity';
import { MessageAnnotationService } from './message-annotation.service';

/** A small global store service; it has no controller and exposes no default API/read surface. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Message, MessageAnnotation], 'data')],
  providers: [MessageAnnotationService],
  exports: [MessageAnnotationService],
})
export class MessageAnnotationsModule {}
