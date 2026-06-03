import { Global, Module } from '@nestjs/common';
import { HookManager } from './hook-manager.service';
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';

@Global() // Make HookManager available everywhere without importing
@Module({
  providers: [HookManager, PluginCircuitBreaker],
  exports: [HookManager, PluginCircuitBreaker],
})
export class HooksModule {}
