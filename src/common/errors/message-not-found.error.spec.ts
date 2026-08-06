import { NotFoundException } from '@nestjs/common';
import { MessageNotFoundError } from './message-not-found.error';

// reply/forward/react/delete on a message outside the adapter's fetch/store window threw a
// raw Error -> HTTP 500. MessageNotFoundError extends NotFoundException so NestJS maps it to 404
// through the built-in handler (no global filter), surviving the message.service passthrough.
describe('MessageNotFoundError', () => {
  it('is a NotFoundException -> HTTP 404 without a custom global filter', () => {
    const err = new MessageNotFoundError('ABC');
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getStatus()).toBe(404);
  });

  it('formats the message, optionally including the chat id', () => {
    expect(new MessageNotFoundError('ABC').message).toBe('Message ABC not found');
    expect(new MessageNotFoundError('ABC', 'c@s.whatsapp.net').message).toBe(
      'Message ABC not found in chat c@s.whatsapp.net',
    );
  });
});
