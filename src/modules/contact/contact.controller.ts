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
  @ApiOperation({ summary: 'Check if a phone number exists on WhatsApp' })
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
