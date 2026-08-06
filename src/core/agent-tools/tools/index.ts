import type { SessionService } from '../../../modules/session/session.service';
import type { MessageService } from '../../../modules/message/message.service';
import type { ContactService } from '../../../modules/contact/contact.service';
import type { GroupService } from '../../../modules/group/group.service';
import type { WebhookService } from '../../../modules/webhook/webhook.service';
import type { LabelService } from '../../../modules/label/label.service';
import type { AutomationRulesService } from '../../../modules/automation/automation-rules.service';
import type { AnyToolDescriptor } from '../tool-descriptor';
import { sessionTools } from './session.tools';
import { messageTools } from './message.tools';
import { contactTools } from './contact.tools';
import { groupTools } from './group.tools';
import { webhookTools } from './webhook.tools';
import { labelTools } from './label.tools';
import { automationTools } from './automation.tools';

/** The services each tool family needs. Stubs suffice where a spec only inspects declarations. */
export interface AgentToolDeps {
  session: SessionService;
  message: MessageService;
  contact: ContactService;
  group: GroupService;
  webhook: WebhookService;
  labels: LabelService;
  automation: AutomationRulesService;
}

/**
 * The complete tool surface, in one place.
 *
 * The module used to assemble this inline while the specs assembled their own copies, so a family
 * added to the module was invisible to the checks meant to police it — the published name list and
 * the session-scope invariant both silently kept passing. Composing once means a new family is
 * covered by construction rather than by remembering to list it three times.
 */
export function allAgentTools(deps: AgentToolDeps): AnyToolDescriptor[] {
  return [
    ...sessionTools(deps.session),
    ...messageTools(deps.message),
    ...contactTools(deps.contact),
    ...groupTools(deps.group),
    ...webhookTools(deps.webhook),
    ...labelTools(deps.labels),
    ...automationTools(deps.automation),
  ];
}
