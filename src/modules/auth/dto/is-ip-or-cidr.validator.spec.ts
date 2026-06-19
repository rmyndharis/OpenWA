import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { isIpOrCidr } from './is-ip-or-cidr.validator';
import { CreateApiKeyDto } from './api-key.dto';

describe('isIpOrCidr', () => {
  it.each([
    '10.0.0.1',
    '192.168.1.255',
    '255.255.255.255',
    '10.0.0.0/8', // the documented allowedIps example
    '192.168.0.0/16',
    '0.0.0.0/0',
    '10.0.0.0/32',
  ])('accepts IPv4 literal/CIDR %s', v => {
    expect(isIpOrCidr(v)).toBe(true);
  });

  it.each([
    'not-an-ip',
    '300.0.0.1',
    '10.0.0.0/33', // IPv4 prefix too long
    '10.0.0.0/', // missing bits
    '10.0.0.0/x',
    '',
  ])('rejects malformed %s', v => {
    expect(isIpOrCidr(v)).toBe(false);
  });

  // IPv6 is rejected on purpose: the allowedIps matcher (auth.service) is IPv4-only, so an IPv6
  // CIDR would either lock out its own client (/128) or match every IPv6 client (/<=32). The
  // validator must not bless an entry the matcher can't enforce. allowedIps is IPv4-only.
  it.each(['::1', '2001:db8::1', '::/0', '2001:db8::/32', '::1/128', 'fe80::1%eth0', '::ffff:10.0.0.1'])(
    'rejects IPv6 (unsupported by the matcher) %s',
    v => {
      expect(isIpOrCidr(v)).toBe(false);
    },
  );
});

describe('CreateApiKeyDto allowedIps (@Validate each)', () => {
  const errorsFor = async (allowedIps: unknown): Promise<string[]> => {
    const dto = plainToInstance(CreateApiKeyDto, { name: 'valid-name', allowedIps });
    const errors = await validate(dto);
    // Scope to the allowedIps field so an unrelated field error can't mask the assertion.
    return errors.filter(e => e.property === 'allowedIps').flatMap(e => Object.values(e.constraints ?? {}));
  };

  it('accepts an array of valid IPv4 literals and CIDRs', async () => {
    expect(await errorsFor(['10.0.0.1', '10.0.0.0/8'])).toEqual([]);
  });

  it('rejects when any element is malformed (per-element each: true)', async () => {
    const msgs = await errorsFor(['10.0.0.1', 'nope', '10.0.0.0/8']);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('rejects an IPv6 element (matcher is IPv4-only)', async () => {
    expect((await errorsFor(['2001:db8::/32'])).length).toBeGreaterThan(0);
  });

  it('rejects a non-string element', async () => {
    expect((await errorsFor(['10.0.0.1', 42])).length).toBeGreaterThan(0);
  });
});
