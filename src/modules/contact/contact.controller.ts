import { Controller, Get, Post, Delete, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('contacts')
@Controller('sessions/:sessionId/contacts')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contacts for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of contacts',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max contacts to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of contacts to skip (for paging)' })
  async findAll(
    @Param('sessionId') sessionId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.contactService.getContacts(sessionId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('profile-pictures')
  @ApiOperation({
    summary: 'Batch-resolve profile picture URLs for up to 50 contacts',
    description:
      'One request for a whole chat sidebar — avoids the burst of parallel single fetches that ' +
      'would exhaust the per-IP throttle. Engine lookups run 3 at a time; per-id failures return null.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'ids', required: true, description: 'Comma-separated contact ids (max 50 used)' })
  // NOTE: declared BEFORE @Get(':contactId') so the literal segment wins over the param route.
  async getProfilePictures(@Param('sessionId') sessionId: string, @Query('ids') ids?: string) {
    const list = (ids ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const pictures = await this.contactService.getProfilePictures(sessionId, list);
    return { pictures };
  }

  @Get(':contactId')
  @ApiOperation({ summary: 'Get a specific contact by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact details',
  })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    return this.contactService.getContactById(sessionId, contactId);
  }

  @Get('check/:number')
  @ApiOperation({
    summary: 'Check if a phone number exists on WhatsApp',
    description:
      'Returns whether the number is a registered WhatsApp account and its canonical id. Use this to ' +
      'pre-validate a recipient before sending: the send endpoints return 201 on accepting a message ' +
      'even for numbers that are not on WhatsApp, so this is the only way to confirm a new number is ' +
      'reachable before you send to it.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'number', description: 'Phone number to check (e.g., 628123456789)' })
  @ApiResponse({
    status: 200,
    description: 'Number existence check result',
  })
  async checkNumber(@Param('sessionId') sessionId: string, @Param('number') number: string) {
    // The engine returns the canonical chat id in its native format; we don't build the JID here
    // (decoupled from the whatsapp-web.js `@c.us` scheme).
    const whatsappId = await this.contactService.getNumberId(sessionId, number);
    return {
      number,
      exists: whatsappId !== null,
      whatsappId,
    };
  }

  // ========== Gap Quick Wins: Profile Picture, Block/Unblock ==========

  @Get(':contactId/profile-picture')
  @ApiOperation({ summary: 'Get profile picture URL for a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Profile picture URL',
  })
  async getProfilePicture(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    const url = await this.contactService.getProfilePicture(sessionId, contactId);
    return { url };
  }

  @Get(':contactId/phone')
  @ApiOperation({ summary: 'Resolve a contact id (e.g. an @lid) to a phone number — best-effort' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID / JID to resolve (e.g., an @lid)' })
  @ApiResponse({
    status: 200,
    description: 'Resolved phone number (MSISDN digits), or null when the engine cannot map it',
  })
  async resolvePhone(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    const phone = await this.contactService.resolveContactPhone(sessionId, contactId);
    return { contactId, phone };
  }

  @Post(':contactId/block')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact blocked',
  })
  async blockContact(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    await this.contactService.blockContact(sessionId, contactId);
    return { success: true, message: 'Contact blocked' };
  }

  @Delete(':contactId/block')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Unblock a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact unblocked',
  })
  async unblockContact(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    await this.contactService.unblockContact(sessionId, contactId);
    return { success: true, message: 'Contact unblocked' };
  }
}
