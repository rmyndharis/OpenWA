import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionPool } from './entities/session-pool.entity';
import { SessionPoolService } from './session-pool.service';
import { SessionPoolController } from './session-pool.controller';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [TypeOrmModule.forFeature([SessionPool], 'data'), SessionModule],
  controllers: [SessionPoolController],
  providers: [SessionPoolService],
  exports: [SessionPoolService],
})
export class SessionPoolModule {}
