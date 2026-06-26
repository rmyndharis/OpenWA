import { z } from 'zod';
import { sessionTools } from './tools/session.tools';
import { messageTools } from './tools/message.tools';
import { contactTools } from './tools/contact.tools';
import { groupTools } from './tools/group.tools';
import { webhookTools } from './tools/webhook.tools';
import type { ToolDescriptor } from './tool-descriptor';

// Registry-level invariant (not a per-tool enumeration): EVERY sessionScoped tool must require a
// non-empty sessionId. tool-invoker only passes sessionId into the allowedSessions fence when it is a
// non-empty string (auth.service skips the fence on a falsy sessionId), so a sessionScoped tool whose
// schema makes sessionId optional or accepts '' would let a session-restricted key bypass scope.
// This catches a FUTURE tool authored with z.string().optional() — no test edit needed when one is added.
describe('agent-tool registry: every sessionScoped tool requires a non-empty sessionId', () => {
  // Handlers are never invoked here; stub services are fine — we only inspect the schema/flags.
  const allTools: ToolDescriptor[] = [
    ...sessionTools({} as never),
    ...messageTools({} as never),
    ...contactTools({} as never),
    ...groupTools({} as never),
    ...webhookTools({} as never),
  ];

  const sessionScoped = allTools.filter(t => t.sessionScoped === true);

  it('has sessionScoped tools to check (the guard is meaningful)', () => {
    expect(sessionScoped.length).toBeGreaterThan(0);
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
