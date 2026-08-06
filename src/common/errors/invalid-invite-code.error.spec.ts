import { BadRequestException } from '@nestjs/common';
import { InvalidInviteCodeError } from './invalid-invite-code.error';

// Joining via an invalid/expired/revoked invite code is a client error, not a server fault:
// InvalidInviteCodeError extends BadRequestException so NestJS maps it to 400 through the built-in
// handler (no global filter) — same mapping discipline as CallNotFoundError.
describe('InvalidInviteCodeError', () => {
  it('is a BadRequestException -> HTTP 400 without a custom global filter', () => {
    const err = new InvalidInviteCodeError();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
  });

  it('states the possible causes in the message', () => {
    expect(new InvalidInviteCodeError().message).toBe(
      'could not join the group — the invite code may be invalid, expired, or revoked',
    );
  });
});
