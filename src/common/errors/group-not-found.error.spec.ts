import { NotFoundException } from '@nestjs/common';
import { GroupNotFoundError } from './group-not-found.error';

// A group settings write against an unknown/non-group id thrown as a generic Error surfaces as
// HTTP 500. GroupNotFoundError extends NotFoundException so NestJS maps it to 404 through the
// built-in handler (no global filter) — same mapping discipline as MessageNotFoundError.
describe('GroupNotFoundError', () => {
  it('is a NotFoundException -> HTTP 404 without a custom global filter', () => {
    const err = new GroupNotFoundError('120363@g.us');
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getStatus()).toBe(404);
  });

  it('formats the message with the group id', () => {
    expect(new GroupNotFoundError('120363@g.us').message).toBe('Group 120363@g.us not found');
  });
});
