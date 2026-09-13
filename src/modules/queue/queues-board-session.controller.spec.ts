import { ForbiddenException } from '@nestjs/common';
import { Request, Response } from 'express';
import { QueuesBoardSessionController } from './queues-board-session.controller';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

describe('QueuesBoardSessionController', () => {
  const companionKey = { role: ApiKeyRole.COMPANION_OPERATOR } as ApiKey;

  function build(auth: Pick<AuthService, 'canAccessOpenWaQueues'>) {
    return new QueuesBoardSessionController(auth as AuthService);
  }

  it('sets HttpOnly cookie for companion_operator with canAccessOpenWaQueues', () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(true) };
    const ctrl = build(auth);
    const req = { headers: { 'x-api-key': 'secret-key' }, secure: false } as unknown as Request;

    ctrl.mint(req, companionKey, res);

    expect(auth.canAccessOpenWaQueues).toHaveBeenCalledWith(companionKey);
    expect(res.cookie).toHaveBeenCalledWith(
      'openwa_bb_key',
      'secret-key',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/admin/queues',
        maxAge: 3600_000,
      }),
    );
  });

  it('reads raw key from Authorization Bearer when x-api-key is absent', () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(true) };
    const ctrl = build(auth);
    const req = {
      headers: { authorization: 'Bearer bearer-secret' },
      secure: false,
    } as unknown as Request;

    ctrl.mint(req, companionKey, res);

    expect(res.cookie).toHaveBeenCalledWith('openwa_bb_key', 'bearer-secret', expect.any(Object));
  });

  it('forbids mint when canAccessOpenWaQueues is false', () => {
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(false) };
    const ctrl = build(auth);
    const req = { headers: { 'x-api-key': 'x' }, secure: false } as unknown as Request;
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;

    expect(() => ctrl.mint(req, companionKey, res)).toThrow(ForbiddenException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('clears the board session cookie on DELETE with attrs matching mint (HTTPS)', () => {
    const auth = { canAccessOpenWaQueues: jest.fn() };
    const ctrl = build(auth);
    const req = { secure: true } as unknown as Request;
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;

    ctrl.clear(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('openwa_bb_key', {
      path: '/api/admin/queues',
      secure: true,
      sameSite: 'strict',
    });
  });

  it('clears cookie with secure:false when not production and req.secure is false', () => {
    const auth = { canAccessOpenWaQueues: jest.fn() };
    const ctrl = build(auth);
    const req = { secure: false } as unknown as Request;
    const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;

    ctrl.clear(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('openwa_bb_key', {
      path: '/api/admin/queues',
      secure: false,
      sameSite: 'strict',
    });
  });
});
