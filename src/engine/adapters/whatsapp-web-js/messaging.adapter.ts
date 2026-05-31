import { MessageMedia } from 'whatsapp-web.js';
import {
  MessageResult,
  MediaInput,
  LocationInput,
  ContactCard,
  MessageReaction,
} from '../../interfaces/whatsapp-engine.interface';
import { MessageWithReactions } from '../../types/whatsapp-web-js.types';
import { AdapterContext } from './context';

/**
 * Messaging concern: sending text/media/location/contact/sticker, replying,
 * forwarding, reactions, and deletion. Bodies moved verbatim from the
 * monolithic adapter; behavior is identical.
 */
export class MessagingAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    const msg = await client.sendMessage(chatId, text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const client = this.ctx.requireClient();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await client.sendMessage(chatId, messageMedia, {
      caption: media.caption,
    });

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await client.sendMessage(chatId, loc);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await client.sendMessage(chatId, vcard, {
      parseVCards: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await client.sendMessage(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    // Find the message to quote
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.ctx.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.ctx.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }
}
