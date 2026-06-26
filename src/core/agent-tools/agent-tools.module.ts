import { Global, Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { SessionModule } from '../../modules/session/session.module';
import { MessageModule } from '../../modules/message/message.module';
import { ContactModule } from '../../modules/contact/contact.module';
import { GroupModule } from '../../modules/group/group.module';
import { WebhookModule } from '../../modules/webhook/webhook.module';
import { SessionService } from '../../modules/session/session.service';
import { MessageService } from '../../modules/message/message.service';
import { ContactService } from '../../modules/contact/contact.service';
import { GroupService } from '../../modules/group/group.service';
import { WebhookService } from '../../modules/webhook/webhook.service';
import { sessionTools } from './tools/session.tools';
import { messageTools } from './tools/message.tools';
import { contactTools } from './tools/contact.tools';
import { groupTools } from './tools/group.tools';
import { webhookTools } from './tools/webhook.tools';

@Global()
@Module({
  imports: [SessionModule, MessageModule, ContactModule, GroupModule, WebhookModule],
  providers: [
    {
      provide: ToolRegistryService,
      inject: [SessionService, MessageService, ContactService, GroupService, WebhookService],
      useFactory: (
        session: SessionService,
        message: MessageService,
        contact: ContactService,
        group: GroupService,
        webhook: WebhookService,
      ) =>
        new ToolRegistryService([
          ...sessionTools(session),
          ...messageTools(message),
          ...contactTools(contact),
          ...groupTools(group),
          ...webhookTools(webhook),
        ]),
    },
  ],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
