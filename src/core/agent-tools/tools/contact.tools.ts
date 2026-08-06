import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { ContactService } from '../../../modules/contact/contact.service';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function contactTools(contact: ContactService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'ContactFindAll',
      description: 'List all contacts for a session. Use limit/offset to page through large contact lists.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: input => contact.getContacts(input.sessionId, { limit: input.limit, offset: input.offset }),
    }),
    defineTool({
      name: 'ContactFindOne',
      description: 'Get details for a specific contact by JID (e.g. 628xxx@c.us).',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        contactId: z.string().describe('Contact JID (e.g. 628123456789@c.us)'),
      }),
      handler: input => contact.getContactById(input.sessionId, input.contactId),
    }),
    defineTool({
      name: 'ContactCheckNumber',
      description:
        'Check whether a phone number is registered on WhatsApp. Returns exists flag and the WhatsApp JID if found.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        number: z.string().describe('Phone number to check (e.g. 628123456789, digits only)'),
      }),
      handler: async input => {
        const whatsappId = await contact.getNumberId(input.sessionId, input.number);
        return { number: input.number, exists: whatsappId !== null, whatsappId };
      },
    }),
    defineTool({
      name: 'ContactResolvePhone',
      description:
        'Resolve a contact JID (e.g. an @lid) to a phone number. Best-effort — returns null when the engine cannot map it.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        contactId: z.string().describe('Contact JID to resolve (e.g. an @lid)'),
      }),
      handler: async input => {
        const phone = await contact.resolveContactPhone(input.sessionId, input.contactId);
        return { contactId: input.contactId, phone };
      },
    }),
    defineTool({
      name: 'ContactGetProfilePicture',
      description: 'Get the profile picture URL for a contact.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        contactId: z.string().describe('Contact JID (e.g. 628123456789@c.us)'),
      }),
      handler: async input => {
        const url = await contact.getProfilePicture(input.sessionId, input.contactId);
        return { url };
      },
    }),
    defineTool({
      name: 'ContactBlock',
      description: 'Block a contact. The contact will no longer be able to send messages. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        contactId: z.string().describe('Contact JID (e.g. 628123456789@c.us)'),
      }),
      handler: async input => {
        await contact.blockContact(input.sessionId, input.contactId);
        return { success: true, message: 'Contact blocked' };
      },
    }),
    defineTool({
      name: 'ContactUnblock',
      description: 'Unblock a previously blocked contact. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        contactId: z.string().describe('Contact JID (e.g. 628123456789@c.us)'),
      }),
      handler: async input => {
        await contact.unblockContact(input.sessionId, input.contactId);
        return { success: true, message: 'Contact unblocked' };
      },
    }),
  ];
}
