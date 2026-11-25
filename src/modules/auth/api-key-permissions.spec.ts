import {
  API_KEY_CAPABILITIES,
  ApiKeyCapability,
  apiKeyDeniedCapabilities,
  hasBlockedCapabilities,
  isCapabilityDenied,
  normalizeDeniedCapabilities,
} from './api-key-permissions';

describe('normalizeDeniedCapabilities', () => {
  it.each([null, undefined, [], ['   '], [''], ['not-a-capability'], ['42']])('reads %p as nothing blocked', value => {
    expect(normalizeDeniedCapabilities(value)).toBeNull();
  });

  it('keeps known capabilities in the order given, trimmed and deduplicated', () => {
    expect(
      normalizeDeniedCapabilities([
        ApiKeyCapability.MESSAGES_SEND,
        ' messages:read ',
        ApiKeyCapability.MESSAGES_SEND,
        'bogus',
      ]),
    ).toEqual([ApiKeyCapability.MESSAGES_SEND, ApiKeyCapability.MESSAGES_READ]);
  });

  it('drops an entry written by a release this build does not know', () => {
    // It would block nothing (enforcement is a membership test) but would read back as if it meant
    // something, so a write through this build must not preserve it.
    expect(normalizeDeniedCapabilities(['messages:future', ApiKeyCapability.CONTACTS_READ])).toEqual([
      ApiKeyCapability.CONTACTS_READ,
    ]);
  });

  it('publishes every enum member exactly once', () => {
    expect(new Set(API_KEY_CAPABILITIES).size).toBe(API_KEY_CAPABILITIES.length);
    expect(API_KEY_CAPABILITIES).toEqual(Object.values(ApiKeyCapability));
  });
});

describe('blocklist predicates', () => {
  it('treats NULL, empty and unknown-only lists as nothing blocked', () => {
    for (const deniedPermissions of [null, [], ['bogus']] as Array<ApiKeyCapability[] | null>) {
      expect(hasBlockedCapabilities({ deniedPermissions })).toBe(false);
      expect(apiKeyDeniedCapabilities({ deniedPermissions })).toEqual([]);
      expect(isCapabilityDenied({ deniedPermissions }, ApiKeyCapability.MESSAGES_READ)).toBe(false);
    }
  });

  it('denies only the listed capability', () => {
    const key = { deniedPermissions: [ApiKeyCapability.MESSAGES_READ] };
    expect(hasBlockedCapabilities(key)).toBe(true);
    expect(isCapabilityDenied(key, ApiKeyCapability.MESSAGES_READ)).toBe(true);
    expect(isCapabilityDenied(key, ApiKeyCapability.MESSAGES_SEND)).toBe(false);
  });
});
