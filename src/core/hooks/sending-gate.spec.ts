import { BadRequestException } from '@nestjs/common';
import { applySendingGate } from './sending-gate';
import { HookManager } from './hook-manager.service';
import { LoggerService } from '../../common/services/logger.service';

/**
 * The gate returned `(hookData as { input: T }).input` with no check that the hook chain's reply
 * still carried an envelope. A `message:sending` handler returning any other truthy object made the
 * gate hand `undefined` to the caller, which then dereferenced it — one plugin authoring mistake
 * turned EVERY outbound send on that session into an unhandled TypeError and a 500 whose text named
 * no plugin. A `data: null` made the gate itself throw. Nothing covered this file at all.
 */
describe('applySendingGate', () => {
  const dto = { chatId: 'c@c.us', text: 'hi' };
  const gate = (result: unknown): Promise<typeof dto> =>
    applySendingGate(
      { execute: jest.fn().mockResolvedValue(result) } as unknown as HookManager,
      's1',
      'text',
      dto,
      'MessageService',
    );

  it('returns the plugin-modified input when the envelope is intact', async () => {
    const rewritten = { chatId: 'c@c.us', text: 'redacted' };
    await expect(gate({ continue: true, data: { input: rewritten } })).resolves.toEqual(rewritten);
  });

  it('pins routing fields to caller values while preserving content rewrites', async () => {
    const original = {
      chatId: 'orig@c.us',
      toChatId: 'dest@c.us',
      fromChatId: 'src@c.us',
      quotedMessageId: 'q-orig',
      messageId: 'm-orig',
      text: 'hello',
      caption: 'before',
      url: 'https://example.com/a.jpg',
      body: 'old',
      mentions: ['111@c.us'],
    };
    const result = await applySendingGate(
      {
        execute: jest.fn().mockResolvedValue({
          continue: true,
          data: {
            input: {
              chatId: 'hijacked@c.us',
              toChatId: 'hijacked-dest@c.us',
              fromChatId: 'hijacked-src@c.us',
              quotedMessageId: 'q-hijacked',
              messageId: 'm-hijacked',
              text: 'moderated',
              caption: 'after',
              url: 'https://example.com/b.jpg',
              body: 'new',
              mentions: ['222@c.us'],
            },
          },
        }),
      } as unknown as HookManager,
      's1',
      'text',
      original,
      'MessageService',
    );

    expect(result).toEqual({
      chatId: 'orig@c.us',
      toChatId: 'dest@c.us',
      fromChatId: 'src@c.us',
      quotedMessageId: 'q-orig',
      messageId: 'm-orig',
      text: 'moderated',
      caption: 'after',
      url: 'https://example.com/b.jpg',
      body: 'new',
      mentions: ['222@c.us'],
    });
  });

  it('strips routing fields that were absent or undefined on the caller input', async () => {
    const unquoted = { chatId: 'orig@c.us', text: 'hello', quotedMessageId: undefined as string | undefined };
    const result = await applySendingGate(
      {
        execute: jest.fn().mockResolvedValue({
          continue: true,
          data: {
            input: {
              chatId: 'other@c.us',
              toChatId: 'injected-to@c.us',
              fromChatId: 'injected-from@c.us',
              quotedMessageId: 'injected-quote',
              messageId: 'injected-msg',
              text: 'edited',
            },
          },
        }),
      } as unknown as HookManager,
      's1',
      'text',
      unquoted,
      'MessageService',
    );

    expect(result).toEqual({ chatId: 'orig@c.us', text: 'edited' });
    expect('quotedMessageId' in result).toBe(false);
    expect('toChatId' in result).toBe(false);
    expect('fromChatId' in result).toBe(false);
    expect('messageId' in result).toBe(false);
  });

  it('pins routing fields even when a plugin mutates data.input in place', async () => {
    const original = { chatId: 'orig@c.us', text: 'hello' };
    const result = await applySendingGate(
      {
        execute: jest.fn((_event: string, data: { input: Record<string, unknown> }) => {
          data.input.chatId = 'mutated@c.us';
          data.input.quotedMessageId = 'injected-quote';
          data.input.text = 'rewritten';
          return Promise.resolve({ continue: true, data });
        }),
      } as unknown as HookManager,
      's1',
      'text',
      original,
      'MessageService',
    );

    expect(result).toEqual({ chatId: 'orig@c.us', text: 'rewritten' });
    expect('quotedMessageId' in result).toBe(false);
  });

  it('deep-clones input before invoking hooks so nested mutations do not corrupt caller objects', async () => {
    const original = { chatId: 'orig@c.us', text: 'hello', mentions: ['111@c.us'], meta: { tag: 'orig' } };
    const result = await applySendingGate(
      {
        execute: jest.fn((_event: string, data: { input: { mentions: string[]; meta: { tag: string } } }) => {
          data.input.mentions.push('999@c.us');
          data.input.meta.tag = 'mutated';
          return Promise.resolve({ continue: true });
        }),
      } as unknown as HookManager,
      's1',
      'text',
      original,
      'MessageService',
    );

    expect(original.mentions).toEqual(['111@c.us']);
    expect(original.meta).toEqual({ tag: 'orig' });
    expect(result.mentions).toEqual(['111@c.us']);
    expect(result.meta).toEqual({ tag: 'orig' });
  });

  it('uses Object.hasOwn for routing fields and strips prototype-pollution keys from hook output', async () => {
    const inherited = Object.assign(Object.create({ chatId: 'inherited@c.us' }) as Record<string, unknown>, {
      text: 'hello',
    });
    const pollutedOutput = JSON.parse(
      '{"text":"ok","chatId":"injected@c.us","__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2}}',
    ) as Record<string, unknown>;

    const result = await applySendingGate(
      {
        execute: jest.fn().mockResolvedValue({ continue: true, data: { input: pollutedOutput } }),
      } as unknown as HookManager,
      's1',
      'text',
      inherited,
      'StatusService',
    );

    expect(result).toEqual({ text: 'ok' });
    expect(Object.hasOwn(result, 'chatId')).toBe(false);
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(Object.hasOwn(result, 'constructor')).toBe(false);
    expect(Object.hasOwn(result, 'prototype')).toBe(false);
  });

  it('recursively strips prototype-pollution keys inside nested objects and arrays', async () => {
    const nestedPolluted = JSON.parse(
      '{"chatId":"c@c.us","text":"hi","customLinkPreview":{"title":"x","__proto__":{"polluted":true},"constructor":{"bad":1}},"contacts":[{"name":"Ada","__proto__":{"polluted":true},"prototype":{"bad":2}}]}',
    ) as Record<string, unknown>;

    const result = await applySendingGate<Record<string, unknown>>(
      {
        execute: jest.fn().mockResolvedValue({ continue: true, data: { input: nestedPolluted } }),
      } as unknown as HookManager,
      's1',
      'text',
      { chatId: 'c@c.us', text: 'hi' },
      'MessageService',
    );

    const preview = result.customLinkPreview as Record<string, unknown>;
    const contact = (result.contacts as Array<Record<string, unknown>>)[0];
    expect(preview).toEqual({ title: 'x' });
    expect(Object.hasOwn(preview, '__proto__')).toBe(false);
    expect(Object.hasOwn(preview, 'constructor')).toBe(false);
    expect(contact).toEqual({ name: 'Ada' });
    expect(Object.hasOwn(contact, '__proto__')).toBe(false);
    expect(Object.hasOwn(contact, 'prototype')).toBe(false);
  });

  it('pins StatusService options.recipients against rewrites, deletion, and injection while preserving other option edits', async () => {
    const hm = new HookManager();
    const seenByModerator: unknown[] = [];

    // Plugin A attempts to spoof options.recipients while rewriting styling and text.
    hm.register(
      'rewriter',
      'message:sending',
      ctx => {
        const data = ctx.data as { input: { text: string; options?: Record<string, unknown> } };
        return Promise.resolve({
          continue: true,
          data: {
            ...data,
            input: {
              text: 'edited-status',
              options: { ...data.input.options, backgroundColor: '#000000', recipients: ['evil@c.us'] },
            },
          },
        });
      },
      10,
    );
    // Plugin B observes the normalized envelope after Plugin A.
    hm.register(
      'moderator',
      'message:sending',
      ctx => {
        const data = ctx.data as { input: { options?: { recipients?: unknown } } };
        seenByModerator.push(data.input.options?.recipients);
        return Promise.resolve({ continue: true, data });
      },
      20,
    );

    const withRecipients = await applySendingGate(
      hm,
      's1',
      'status-text',
      { text: 'orig', options: { recipients: ['alice@c.us'], backgroundColor: '#ffffff' } },
      'StatusService',
    );
    expect(seenByModerator).toEqual([['alice@c.us']]);
    expect(withRecipients).toEqual({
      text: 'edited-status',
      options: { recipients: ['alice@c.us'], backgroundColor: '#000000' },
    });

    // When caller did not set options.recipients, a plugin cannot inject it.
    seenByModerator.length = 0;
    const withoutRecipients = await applySendingGate(
      hm,
      's1',
      'status-text',
      { text: 'orig', options: { backgroundColor: '#ffffff' } },
      'StatusService',
    );
    expect(seenByModerator).toEqual([undefined]);
    expect(withoutRecipients).toEqual({ text: 'edited-status', options: { backgroundColor: '#000000' } });
    expect(Object.hasOwn(withoutRecipients.options, 'recipients')).toBe(false);

    // Deleting options altogether still restores caller's options.recipients.
    const dropOptionsHm = new HookManager();
    dropOptionsHm.register('dropper', 'message:sending', ctx => {
      const data = ctx.data as { input: Record<string, unknown> };
      return Promise.resolve({ continue: true, data: { ...data, input: { text: 'dropped' } } });
    });
    const preserved = await applySendingGate(
      dropOptionsHm,
      's1',
      'status-text',
      { text: 'orig', options: { recipients: ['alice@c.us'] } },
      'StatusService',
    );
    expect(preserved).toEqual({ text: 'dropped', options: { recipients: ['alice@c.us'] } });

    // Non-plain options objects (prototype-inherited recipients or class instances) cannot bypass pinning.
    class CustomStatusOptions {
      constructor(
        public recipients: string[],
        public backgroundColor: string,
      ) {}
    }
    const inheritedOptions = Object.create({ recipients: ['attacker@c.us'] }) as Record<string, unknown>;
    inheritedOptions.backgroundColor = '#111111';

    const fromInherited = await applySendingGate(
      {
        execute: jest.fn().mockResolvedValue({
          continue: true,
          data: { input: { text: 'ok', options: inheritedOptions } },
        }),
      } as unknown as HookManager,
      's1',
      'status-text',
      { text: 'orig', options: { backgroundColor: '#ffffff' } },
      'StatusService',
    );
    expect(fromInherited).toEqual({ text: 'ok', options: { backgroundColor: '#111111' } });
    expect('recipients' in fromInherited.options).toBe(false);

    const fromClassInstance = await applySendingGate(
      {
        execute: jest.fn().mockResolvedValue({
          continue: true,
          data: { input: { text: 'ok', options: new CustomStatusOptions(['attacker@c.us'], '#222222') } },
        }),
      } as unknown as HookManager,
      's1',
      'status-text',
      { text: 'orig', options: { recipients: ['alice@c.us'], backgroundColor: '#ffffff' } },
      'StatusService',
    );
    expect(fromClassInstance).toEqual({
      text: 'ok',
      options: { recipients: ['alice@c.us'], backgroundColor: '#222222' },
    });
  });

  it('fails closed when a plugin returns a payload nested deeper than MAX_SANITIZE_DEPTH', async () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 70; i++) {
      deep = { child: deep };
    }

    // Mock HookManager (post-gate path).
    await expect(
      applySendingGate(
        {
          execute: jest.fn().mockResolvedValue({
            continue: true,
            data: { input: { chatId: 'c@c.us', text: 'hi', extra: deep } },
          }),
        } as unknown as HookManager,
        's1',
        'text',
        { chatId: 'c@c.us', text: 'hi' },
        'MessageService',
      ),
    ).rejects.toThrow(/maximum nesting depth/);

    // Real HookManager (inter-handler normalizeData path).
    const hm = new HookManager();
    hm.register('deep-plugin', 'message:sending', ctx => {
      const d = ctx.data as { input: Record<string, unknown> };
      return Promise.resolve({ continue: true, data: { ...d, input: { ...d.input, extra: deep } } });
    });
    await expect(
      applySendingGate(hm, 's1', 'text', { chatId: 'c@c.us', text: 'hi' }, 'MessageService'),
    ).rejects.toThrow(/maximum nesting depth/);
  });

  describe('with real HookManager chain', () => {
    it('isolates in-place nested mutations from throwing, errored, or no-data handlers', async () => {
      const hm = new HookManager();
      const callerInput = {
        chatId: '628@c.us',
        text: 'hello',
        mentions: ['62811@c.us'],
        customLinkPreview: { title: 'Original' },
      };

      hm.register(
        'mutates-and-throws',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: typeof callerInput };
          d.input.mentions.push('62991@c.us');
          d.input.customLinkPreview.title = 'FromThrow';
          throw new Error('boom');
        },
        10,
      );
      hm.register(
        'mutates-and-errors',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: typeof callerInput };
          d.input.mentions.push('62992@c.us');
          d.input.customLinkPreview.title = 'FromError';
          return Promise.resolve({ continue: true, data: d, error: new Error('partial') });
        },
        20,
      );
      hm.register(
        'mutates-no-data',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: typeof callerInput };
          d.input.mentions.push('62993@c.us');
          d.input.customLinkPreview.title = 'FromNoData';
          return Promise.resolve({ continue: true });
        },
        30,
      );

      const gated = await applySendingGate(hm, 's1', 'text', callerInput, 'MessageService');

      expect(callerInput.mentions).toEqual(['62811@c.us']);
      expect(callerInput.customLinkPreview).toEqual({ title: 'Original' });
      expect(gated.mentions).toEqual(['62811@c.us']);
      expect(gated.customLinkPreview).toEqual({ title: 'Original' });
    });

    it('prevents an earlier plugin from spoofing chatId seen by a later moderation plugin', async () => {
      const hm = new HookManager();
      const observedChatIds: string[] = [];

      hm.register(
        'spoofer',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: { chatId: string; text: string } };
          return Promise.resolve({
            continue: true,
            data: { ...d, input: { ...d.input, chatId: 'exempt@c.us', text: 'bad content' } },
          });
        },
        10,
      );
      hm.register(
        'moderator',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: { chatId: string; text: string } };
          observedChatIds.push(d.input.chatId);
          if (d.input.chatId === 'restricted@g.us') {
            return Promise.resolve({ continue: false });
          }
          return Promise.resolve({ continue: true, data: d });
        },
        20,
      );

      await expect(
        applySendingGate(hm, 's1', 'text', { chatId: 'restricted@g.us', text: 'hi' }, 'MessageService'),
      ).rejects.toThrow(BadRequestException);
      expect(observedChatIds).toEqual(['restricted@g.us']);
    });

    it('still isolates nested mentions when an earlier plugin attaches a function leaf to input', async () => {
      const hm = new HookManager();
      const fn = () => 'marker';

      hm.register(
        'attaches-fn',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: Record<string, unknown> };
          return Promise.resolve({ continue: true, data: { ...d, input: { ...d.input, helper: fn } } });
        },
        10,
      );
      hm.register(
        'mutates-and-throws',
        'message:sending',
        ctx => {
          const d = ctx.data as { input: { mentions: string[] } };
          d.input.mentions.push('62999@c.us');
          throw new Error('boom');
        },
        20,
      );

      const gated = await applySendingGate(
        hm,
        's1',
        'text',
        { chatId: '628@c.us', text: 'hi', mentions: ['62811@c.us'] },
        'MessageService',
      );
      expect(gated.mentions).toEqual(['62811@c.us']);
    });
  });

  // A stub manager, deliberately: HookManager itself always answers with an envelope (runHandlers
  // returns the data it was given when no handler is registered), so this branch is defensive rather
  // than a path production reaches. Pinned anyway — it is what stops a manager that answers with
  // nothing from being read as a veto.
  it('returns the original input when the chain replies with no data at all', async () => {
    await expect(gate({ continue: true })).resolves.toEqual(dto);
  });

  it('still refuses a send the plugin vetoed', async () => {
    await expect(gate({ continue: false, data: { input: dto } })).rejects.toThrow(BadRequestException);
  });

  // Fail CLOSED, and say why. This is a moderation chokepoint: a handler whose reply cannot be read
  // may have been trying to redact something, so proceeding with the original would be a bypass.
  it.each([
    ['a truthy object with no input', { continue: true, data: { notInput: 1 } }],
    ['a null data', { continue: true, data: null }],
    ['a primitive data', { continue: true, data: 'ok' }],
    ['an input that is not an object', { continue: true, data: { input: 'text' } }],
    ['an array input', { continue: true, data: { input: ['text'] } }],
  ])('refuses the send when the hook returns %s', async (_label, result) => {
    await expect(gate(result)).rejects.toThrow(BadRequestException);
    await expect(gate(result)).rejects.toThrow(/message:sending/);
  });

  /**
   * The 400 goes to the API caller, who is not the person who can fix it: a plugin returning a bad
   * envelope stops EVERY send on that session, and the operator's only evidence was a client-side
   * error they never see. The refusal has to leave a trace on the server, carrying the session and
   * the call site so the failing session is identifiable.
   */
  describe('leaves the operator a trace', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('warns, naming the session and the call site, when the envelope is unusable', async () => {
      await expect(gate({ continue: true, data: { notInput: 1 } })).rejects.toThrow(BadRequestException);

      expect(warn).toHaveBeenCalledTimes(1);
      const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toMatch(/message:sending/);
      expect(context).toMatchObject({ sessionId: 's1', source: 'MessageService', type: 'text' });
    });

    // Negative twin: the ordinary paths must stay quiet, or the signal is worthless.
    it.each([
      ['an intact envelope', { continue: true, data: { input: { chatId: 'c@c.us', text: 'hi' } } }],
      ['no data at all', { continue: true }],
    ])('stays silent on %s', async (_label, result) => {
      await gate(result);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
