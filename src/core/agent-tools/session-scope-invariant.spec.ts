import { allAgentTools } from './tools';
import { z } from 'zod';
import type { AnyToolDescriptor } from './tool-descriptor';

// Registry-level invariant (not a per-tool enumeration): EVERY sessionScoped tool must require a
// non-empty sessionId. tool-invoker only passes sessionId into the allowedSessions fence when it is a
// non-empty string (auth.service skips the fence on a falsy sessionId), so a sessionScoped tool whose
// schema makes sessionId optional or accepts '' would let a session-restricted key bypass scope.
// This catches a FUTURE tool authored with z.string().optional() — no test edit needed when one is added.
describe('agent-tool registry: every sessionScoped tool requires a non-empty sessionId', () => {
  // Handlers are never invoked here; stub services are fine — we only inspect the schema/flags.
  const allTools: AnyToolDescriptor[] = [...allAgentTools({} as never)];

  const sessionScoped = allTools.filter(t => t.sessionScoped === true);

  it('has sessionScoped tools to check (the guard is meaningful)', () => {
    expect(sessionScoped.length).toBeGreaterThan(0);
  });

  /**
   * The other direction, and the one that actually leaks. `tool-invoker` only applies the
   * allowedSessions fence to a tool marked sessionScoped, so a tool that takes a sessionId and
   * forgets the flag lets a session-restricted key act on any session at all. Nothing else notices:
   * the tool works, the schema is valid, and only the fence is missing.
   */
  it('marks every tool that takes a sessionId as sessionScoped', () => {
    const takesSessionId = allTools.filter(tool => {
      const shape = (tool.inputSchema as unknown as z.ZodObject<Record<string, z.ZodType>>).shape;
      return shape != null && 'sessionId' in shape;
    });

    // Guard the guard: a shape probe that silently matched nothing would make this vacuous.
    expect(takesSessionId.length).toBeGreaterThan(0);
    expect(takesSessionId.filter(tool => tool.sessionScoped !== true).map(tool => tool.name)).toEqual([]);
  });

  it.each(sessionScoped.map(t => [t.name, t] as const))(
    '%s rejects a missing and an empty sessionId',
    (_name, tool) => {
      // Isolate the sessionId field so a tool's OTHER required fields can't mask a weakened sessionId rule.
      const shape = (tool.inputSchema as unknown as z.ZodObject<{ sessionId: z.ZodType }>).shape;
      const sessionIdSchema: z.ZodType = shape.sessionId;
      expect(sessionIdSchema).toBeDefined();
      expect(sessionIdSchema.safeParse(undefined).success).toBe(false);
      expect(sessionIdSchema.safeParse('').success).toBe(false);
    },
  );
});
