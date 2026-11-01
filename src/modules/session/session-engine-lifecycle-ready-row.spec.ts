import { readyRowUpdate } from './session-engine-lifecycle.service';
import { SessionStatus } from './entities/session.entity';

/**
 * whatsapp-web.js can report an empty phone at ready (client.info momentarily unreadable). The
 * account-binding guard skips an empty incoming phone rather than rebind-rejecting it, so if the
 * ready row write also clobbered the stored phone with '', the binding would be silently dropped
 * until the next non-empty ready. readyRowUpdate keeps the bound number in that case.
 */
describe('readyRowUpdate', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');

  it('writes the phone when the ready reports one', () => {
    expect(readyRowUpdate('628111', 'Alice', at)).toEqual({
      status: SessionStatus.READY,
      phone: '628111',
      pushName: 'Alice',
      connectedAt: at,
      lastActiveAt: at,
    });
  });

  it('writes only the liveness fields on an empty-phone ready, keeping the bound number and its push name', () => {
    expect(readyRowUpdate('', 'Alice', at)).toEqual({
      status: SessionStatus.READY,
      connectedAt: at,
      lastActiveAt: at,
    });
  });

  // whatsapp-web.js reports both empty when client.info cannot be read at ready.
  it('keeps the stored push name when the ready could read neither the phone nor the name', () => {
    expect(readyRowUpdate('', '', at)).not.toHaveProperty('pushName');
  });

  it('writes an empty push name the account reports along with its phone', () => {
    expect(readyRowUpdate('628111', '', at)).toMatchObject({ phone: '628111', pushName: '' });
  });
});
