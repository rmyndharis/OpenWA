import { Status, TextStatusOptions, StatusResult, MediaInput } from '../../interfaces/whatsapp-engine.interface';
import { AdapterContext } from './context';

/**
 * Status/Stories concern. whatsapp-web.js has limited Status API support, so
 * these remain stubs (warn or throw) exactly as in the monolithic adapter.
 * requireClient() preserves the original READY gate.
 */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
export class StatusAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getContactStatuses(): Promise<Status[]> {
    this.ctx.requireClient();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.ctx.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ctx.requireClient();
    this.ctx.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ctx.requireClient();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ctx.requireClient();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ctx.requireClient();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ctx.requireClient();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }
}
/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
