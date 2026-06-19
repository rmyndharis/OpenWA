import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

describe('BullBoardAuthMiddleware', () => {
  let mw: BullBoardAuthMiddleware;
  let authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
  let configService: { get: jest.Mock };
  const res = {} as Response;

  const reqWith = (headers: Record<string, unknown> = {}, query: Record<string, unknown> = {}): Request =>
    ({ headers, query, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;

  beforeEach(() => {
    authService = { validateApiKey: jest.fn(), hasPermission: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(undefined) }; // no trusted proxies by default
    mw = new BullBoardAuthMiddleware(authService as unknown as AuthService, configService as unknown as ConfigService);
  });

  it('rejects when no API key is provided', async () => {
    const next = jest.fn();
    await mw.use(reqWith({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('propagates an invalid-key rejection', async () => {
    authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'bad' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it('forbids a valid non-admin key', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.OPERATOR });
    authService.hasPermission.mockReturnValue(false);
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'op' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenException));
  });

  it('allows a valid ADMIN key via X-API-Key', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'admin' }), res, next);
    expect(next).toHaveBeenCalledWith();
    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '127.0.0.1');
  });

  it('accepts a Bearer token', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ authorization: 'Bearer abc' }), res, jest.fn());
    expect(authService.validateApiKey).toHaveBeenCalledWith('abc', '127.0.0.1');
  });

  it('honors X-Forwarded-For only behind a configured trusted proxy (allowedIps parity with the guard)', async () => {
    configService.get.mockReturnValue(['127.0.0.1']); // the socket peer is a trusted proxy
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ 'x-api-key': 'admin', 'x-forwarded-for': '203.0.113.5' }), res, jest.fn());

    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '203.0.113.5');
  });

  it('ignores a spoofed X-Forwarded-For when no trusted proxy is configured (uses the socket address)', async () => {
    configService.get.mockReturnValue([]); // no trusted proxies — XFF is attacker-controlled
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ 'x-api-key': 'admin', 'x-forwarded-for': '203.0.113.5' }), res, jest.fn());

    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '127.0.0.1');
  });

  it('rejects an ?apiKey query param (no key in the URL)', async () => {
    const next = jest.fn();
    await mw.use(reqWith({}, { apiKey: 'qkey' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });
});
