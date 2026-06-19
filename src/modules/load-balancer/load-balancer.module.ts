import { Module } from '@nestjs/common';
import { LoadBalancerService } from './load-balancer.service';
import { LoadBalancerController, SendBalancedController } from './load-balancer.controller';
import { SessionModule } from '../session/session.module';
import { MessageModule } from '../message/message.module';

@Module({
  imports: [SessionModule, MessageModule],
  controllers: [LoadBalancerController, SendBalancedController],
  providers: [LoadBalancerService],
  exports: [LoadBalancerService],
})
export class LoadBalancerModule {}
