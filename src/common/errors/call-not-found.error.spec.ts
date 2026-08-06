import { NotFoundException } from '@nestjs/common';
import { CallNotFoundError } from './call-not-found.error';

// Rejecting an unknown/expired call id must surface as HTTP 404, not a raw 500 — same mapping
// discipline as MessageNotFoundError (built-in NestJS handler, no custom global filter).
describe('CallNotFoundError', () => {
  it('is a NotFoundException -> HTTP 404 without a custom global filter', () => {
    const err = new CallNotFoundError('CALL1');
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getStatus()).toBe(404);
  });

  it('formats the message with the call id', () => {
    expect(new CallNotFoundError('CALL1').message).toBe('Call CALL1 not found or no longer ringing');
  });
});
