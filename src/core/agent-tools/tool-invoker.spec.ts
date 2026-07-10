import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { invokeTool } from './tool-invoker';
import type { ToolDescriptor } from './tool-descriptor';
import type { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

const readTool: ToolDescriptor = {
  name: 'T',
  description: 'd',
  tier: 'read',
  inputSchema: z.object({ n: z.number() }),
  handler: input => Promise.resolve({ got: (input as { n: number }).n }),
};

function auth(over: Partial<Record<string, unknown>> = {}): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null, ...over }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

describe('invokeTool', () => {
  it('rejects a missing key', async () => {
    await expect(invokeTool(readTool, { n: 1 }, undefined, auth() as unknown as AuthService)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('validates input AFTER auth and runs the handler', async () => {
    const a = auth();
    const out = await invokeTool(readTool, { n: 5 }, 'rawkey', a as unknown as AuthService);
    expect(a.validateApiKey).toHaveBeenCalledWith('rawkey', undefined, undefined);
    expect(out).toEqual({ got: 5 });
  });

  it('maps a zod failure to BadRequestException', async () => {
    await expect(invokeTool(readTool, { n: 'x' }, 'rawkey', auth() as unknown as AuthService)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('passes sessionId from input to validateApiKey when sessionScoped', async () => {
    const a = auth();
    const scoped: ToolDescriptor = {
      ...readTool,
      sessionScoped: true,
      inputSchema: z.object({ sessionId: z.string() }),
      handler: () => Promise.resolve('ok'),
    };
    await invokeTool(scoped, { sessionId: 's1' }, 'rawkey', a as unknown as AuthService);
    expect(a.validateApiKey).toHaveBeenCalledWith('rawkey', undefined, 's1');
  });

  it('fails closed for a sessionScoped tool when no sessionId is supplied (no auth with an unscoped id)', async () => {
    const a = auth();
    // A sessionScoped tool whose input omits sessionId (e.g. an optional/loose schema): the per-key
    // allowedSessions check would be skipped if undefined reached validateApiKey, so fence it here.
    const scoped: ToolDescriptor = {
      ...readTool,
      sessionScoped: true,
      inputSchema: z.object({ sessionId: z.string().optional() }),
      handler: () => Promise.resolve('ok'),
    };
    await expect(invokeTool(scoped, {}, 'rawkey', a as unknown as AuthService)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(a.validateApiKey).not.toHaveBeenCalled();
  });

  it('rejects when validateApiKey throws for an out-of-scope session', async () => {
    const a = auth();
    (a.validateApiKey as jest.Mock).mockRejectedValueOnce(
      new UnauthorizedException('API key not authorized for this session'),
    );
    const scoped: ToolDescriptor = {
      ...readTool,
      sessionScoped: true,
      inputSchema: z.object({ sessionId: z.string() }),
      handler: () => Promise.resolve('ok'),
    };
    await expect(
      invokeTool(scoped, { sessionId: 'other-session' }, 'rawkey', a as unknown as AuthService),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enforces requiredRole via hasPermission', async () => {
    const a = auth();
    (a.hasPermission as jest.Mock).mockReturnValue(false);
    const writeTool: ToolDescriptor = { ...readTool, tier: 'write', requiredRole: ApiKeyRole.OPERATOR };
    await expect(invokeTool(writeTool, { n: 1 }, 'rawkey', a as unknown as AuthService)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // FIX 3(b): onAuthenticated callback
  it('calls onAuthenticated with apiKey.id after successful validateApiKey', async () => {
    const a = auth({ id: 'key-abc' });
    const onAuthenticated = jest.fn();
    await invokeTool(readTool, { n: 1 }, 'rawkey', a as unknown as AuthService, onAuthenticated);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).toHaveBeenCalledWith('key-abc');
  });

  it('does NOT call onAuthenticated when validateApiKey throws', async () => {
    const a = auth();
    (a.validateApiKey as jest.Mock).mockRejectedValueOnce(new UnauthorizedException('bad key'));
    const onAuthenticated = jest.fn();
    await expect(
      invokeTool(readTool, { n: 1 }, 'rawkey', a as unknown as AuthService, onAuthenticated),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('works without onAuthenticated (backward compatible)', async () => {
    const a = auth();
    // No 5th argument — must not throw
    await expect(invokeTool(readTool, { n: 1 }, 'rawkey', a as unknown as AuthService)).resolves.toBeDefined();
  });

  // onAuthFailure: MCP auth-failure audit hook (mirrors the REST ApiKeyGuard). Fires at the auth boundary
  // only — never on success, never on input-validation/handler errors (parity with the guard).
  describe('onAuthFailure callback (MCP auth-failure audit boundary)', () => {
    it('is invoked with the error on a missing key (Unauthorized)', async () => {
      const onAuthFailure = jest.fn();
      await expect(
        invokeTool(readTool, { n: 1 }, undefined, auth() as unknown as AuthService, undefined, onAuthFailure),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(onAuthFailure).toHaveBeenCalledTimes(1);
      expect((onAuthFailure.mock.calls[0] as unknown[])[0]).toBeInstanceOf(UnauthorizedException);
    });

    it('is invoked on a wrong-role rejection (Forbidden)', async () => {
      const a = auth();
      (a.hasPermission as jest.Mock).mockReturnValue(false);
      const onAuthFailure = jest.fn();
      const writeTool: ToolDescriptor = { ...readTool, tier: 'write', requiredRole: ApiKeyRole.OPERATOR };
      await expect(
        invokeTool(writeTool, { n: 1 }, 'rawkey', a as unknown as AuthService, undefined, onAuthFailure),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(onAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('is invoked when validateApiKey rejects (IP/revoked/expired/session-not-allowed)', async () => {
      const a = auth();
      (a.validateApiKey as jest.Mock).mockRejectedValueOnce(new UnauthorizedException('IP address not allowed'));
      const onAuthFailure = jest.fn();
      await expect(
        invokeTool(readTool, { n: 1 }, 'rawkey', a as unknown as AuthService, undefined, onAuthFailure),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(onAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('is NOT invoked on a successful auth (happy path)', async () => {
      const onAuthFailure = jest.fn();
      await invokeTool(readTool, { n: 1 }, 'rawkey', auth() as unknown as AuthService, undefined, onAuthFailure);
      expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it('is NOT invoked on a post-auth zod validation error (BadRequest)', async () => {
      const onAuthFailure = jest.fn();
      await expect(
        invokeTool(readTool, { n: 'bad' }, 'rawkey', auth() as unknown as AuthService, undefined, onAuthFailure),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it('is NOT invoked when a tool handler throws after successful auth', async () => {
      const onAuthFailure = jest.fn();
      const throwingHandler: ToolDescriptor = {
        ...readTool,
        handler: () => Promise.reject(new ForbiddenException('handler-level forbid')),
      };
      await expect(
        invokeTool(throwingHandler, { n: 1 }, 'rawkey', auth() as unknown as AuthService, undefined, onAuthFailure),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // A handler-thrown 403 is NOT an auth failure — must not be audited as api_key_auth_failed.
      expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it('works without onAuthFailure (backward compatible)', async () => {
      // No 6th argument — a missing key still rejects without calling an undefined hook.
      await expect(invokeTool(readTool, { n: 1 }, undefined, auth() as unknown as AuthService)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
