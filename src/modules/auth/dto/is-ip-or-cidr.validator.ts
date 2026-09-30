import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isIP } from 'net';

/**
 * Whether a string is a valid IPv4 address or IPv4 CIDR range (/0-32).
 *
 * IPv4-only on purpose: `allowedIps` is documented as IPv4-only (docs/04, IPv6 Support). The shared
 * `ipMatches` helper also handles IPv6, so widening this validator is a separate, deliberate change.
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
