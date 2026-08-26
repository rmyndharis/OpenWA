import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingAccount } from './entities/billing-account.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BillingAccount], 'main')],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
