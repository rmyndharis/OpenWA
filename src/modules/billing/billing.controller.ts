import { Controller, Get, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BillingExempt, CurrentPrincipal, Public } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';
import { User } from '../auth/entities/user.entity';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('status')
  @BillingExempt()
  @ApiBearerAuth()
  status(@CurrentPrincipal() principal: ApiKey | User) {
    return this.billing.status(principal);
  }

  @Post('checkout')
  @BillingExempt()
  @ApiBearerAuth()
  checkout(@CurrentPrincipal() principal: ApiKey | User) {
    return this.billing.checkout(principal);
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() request: Request & { rawBody?: Buffer }, @Headers('stripe-signature') signature?: string) {
    await this.billing.handleWebhook(request.rawBody || Buffer.alloc(0), signature);
    return { received: true };
  }
}
