import 'reflect-metadata';
import { REQUIRED_ROLE_KEY } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';
import { IntegrationInstanceController } from '../integration/integration-instance.controller';
import { RedriveController } from '../integration/redrive.controller';
import { GroupController } from '../group/group.controller';
import { ContactController } from '../contact/contact.controller';

// The dashboard's client-side role (seeded from localStorage) is cosmetic UX only — the ACTUAL
// authorization boundary is the backend @RequireRole guard. These assertions lock that the sensitive
// ADMIN-only integration provisioning / redrive surfaces are role-gated server-side at the class level,
// so a tampered client role can never reach them regardless of what the browser claims.
describe('admin controller role coverage (server-side authorization is the real gate)', () => {
  it.each([
    ['IntegrationInstanceController', IntegrationInstanceController],
    ['RedriveController', RedriveController],
  ])('%s requires the ADMIN role at the class level', (_name, controller) => {
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)).toBe(ApiKeyRole.ADMIN);
  });
});

// A group invite code is a bearer capability, not read data: whoever holds the link joins the group
// on WhatsApp with no OpenWA credential at all, and that membership survives revoking the key that
// fetched the code. Both invite-code routes therefore sit at OPERATOR, like the QR endpoint: the
// reads whose payload is a credential for a system outside OpenWA's authority.
describe('group invite-code role coverage (the code is a capability, not read data)', () => {
  it.each(['getInviteCode', 'revokeInviteCode'] as const)('GroupController.%s requires the OPERATOR role', method => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, GroupController.prototype[method])).toBe(ApiKeyRole.OPERATOR);
  });
});

// A number-existence check is an outbound WhatsApp query about a third party, and bulk checks put the
// linked account's standing at risk, so it sits at OPERATOR (the MCP ContactCheckNumber tool too).
// The profile-picture and phone-resolution reads stay open to any key: the dashboard loads avatars
// with a VIEWER key.
describe('contact lookup role coverage', () => {
  it('ContactController.checkNumber requires the OPERATOR role', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, ContactController.prototype.checkNumber)).toBe(ApiKeyRole.OPERATOR);
  });

  it.each(['getProfilePictures', 'getProfilePicture', 'resolvePhone'] as const)(
    'ContactController.%s stays open to any valid key',
    method => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, ContactController.prototype[method])).toBeUndefined();
    },
  );
});
