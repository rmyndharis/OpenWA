import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';
import { XenwaService } from './xenwa.service';
import { XenwaCreateAccountDto, XenwaGrantDto, XenwaSetOwnerDto, XenwaUpdateGrantDto } from './dto/xenwa.dto';

/**
 * XenWA account + team management for the signed-in user. Every handler resolves the caller through
 * XenwaService.actorFor and authorizes inside the service: an SSO user acts on accounts they own, an
 * unscoped ADMIN key acts on any account. Routes carrying `:sessionId` are additionally fenced by the
 * ApiKeyGuard's allowedSessions check.
 */
@ApiExcludeController()
@Controller('xenwa')
export class XenwaController {
  constructor(private readonly xenwa: XenwaService) {}

  @Get('me')
  async me(@CurrentApiKey() apiKey?: ApiKey) {
    return this.xenwa.me(await this.xenwa.actorFor(apiKey));
  }

  @Get('accounts')
  async listAccounts(@CurrentApiKey() apiKey?: ApiKey) {
    return this.xenwa.accounts(await this.xenwa.actorFor(apiKey));
  }

  @Post('accounts')
  async createAccount(@Body() dto: XenwaCreateAccountDto, @CurrentApiKey() apiKey?: ApiKey) {
    const session = await this.xenwa.createAccount(await this.xenwa.actorFor(apiKey), dto.name);
    return { id: session.id, name: session.name, status: session.status };
  }

  @Get('accounts/:sessionId/team')
  async listTeam(@Param('sessionId') sessionId: string, @CurrentApiKey() apiKey?: ApiKey) {
    return this.xenwa.listTeam(await this.xenwa.actorFor(apiKey), sessionId);
  }

  @Post('accounts/:sessionId/team')
  async grant(@Param('sessionId') sessionId: string, @Body() dto: XenwaGrantDto, @CurrentApiKey() apiKey?: ApiKey) {
    return this.xenwa.grant(await this.xenwa.actorFor(apiKey), sessionId, dto.email, dto.permissions ?? []);
  }

  @Patch('accounts/:sessionId/team/:accessId')
  async updateGrant(
    @Param('sessionId') sessionId: string,
    @Param('accessId') accessId: string,
    @Body() dto: XenwaUpdateGrantDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    return this.xenwa.updateGrant(await this.xenwa.actorFor(apiKey), sessionId, accessId, dto.permissions);
  }

  @Delete('accounts/:sessionId/team/:accessId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('sessionId') sessionId: string,
    @Param('accessId') accessId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    await this.xenwa.revoke(await this.xenwa.actorFor(apiKey), sessionId, accessId);
  }

  @Post('accounts/:sessionId/billing/pay')
  async payNow(@Param('sessionId') sessionId: string, @CurrentApiKey() apiKey?: ApiKey) {
    return this.xenwa.payNow(await this.xenwa.actorFor(apiKey), sessionId);
  }

  @Put('accounts/:sessionId/owner')
  async setOwner(
    @Param('sessionId') sessionId: string,
    @Body() dto: XenwaSetOwnerDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    return this.xenwa.setOwner(await this.xenwa.actorFor(apiKey), sessionId, dto.email);
  }
}
