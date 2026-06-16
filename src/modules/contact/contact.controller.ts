import { Controller, Get, Post, Delete, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ContactService } from './contact.service';

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
  async findAll(@Param('sessionId') sessionId: string) {
    return this.contactService.getContacts(sessionId);
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

  @Post(':contactId/block')
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
