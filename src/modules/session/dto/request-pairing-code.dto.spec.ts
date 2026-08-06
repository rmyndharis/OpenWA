import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RequestPairingCodeDto } from './request-pairing-code.dto';

const errorCount = (phoneNumber: unknown): number =>
  validateSync(plainToInstance(RequestPairingCodeDto, { phoneNumber })).length;

describe('RequestPairingCodeDto (#252)', () => {
  it.each(['628123456789', '12025550123', '447911123456'])('accepts a digits-only number: %s', n => {
    expect(errorCount(n)).toBe(0);
  });

  it.each(['', '+628123456789', '628 123 456', '628-123-456', 'abc123', '12345', '0123456789012345'])(
    'rejects a malformed number: %s',
    n => {
      expect(errorCount(n)).toBeGreaterThan(0);
    },
  );
});
