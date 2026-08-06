import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isIP } from 'net';

/**
 * Whether a string is a valid IPv4 address or IPv4 CIDR range (/0-32).
 *
 * IPv4-only on purpose: the allowedIps matcher (auth.service `isIpAllowed`/`ipInCidr`) is IPv4-only,
 * so an IPv6 entry can't be enforced — a /128 host-lock would never match its own client, and an
 * IPv6 /<=32 CIDR would match EVERY IPv6 client (an over-broad grant). The validator must not bless
 * an entry the matcher can't honor, so it rejects IPv6 (`allowedIps` is documented as IPv4-only).
 */
export function isIpOrCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  if (slash === -1) return isIP(value) === 4;
  if (isIP(value.slice(0, slash)) !== 4) return false;
  const bits = value.slice(slash + 1);
  return /^\d{1,2}$/.test(bits) && Number(bits) <= 32;
}

@ValidatorConstraint({ name: 'isIpOrCidr', async: false })
export class IsIpOrCidrConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIpOrCidr(value);
  }
  defaultMessage(): string {
    return 'each allowedIps entry must be a valid IPv4 address or IPv4 CIDR range (e.g. 10.0.0.0/8)';
  }
}
