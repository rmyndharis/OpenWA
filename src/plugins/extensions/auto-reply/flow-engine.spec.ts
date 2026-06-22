import { FlowEngine, FlowConfig } from './flow-engine';
import { PluginContext } from '../../../core/plugins';

describe('FlowEngine', () => {
  let mockStorage: Record<string, any>;
  let replyMock: jest.Mock;
  let context: PluginContext;

  const testConfig: FlowConfig = {
    sessions: {
      'abc-company': {
        enabled: true,
        trigger: 'hi',
        greeting: 'abc companney hi i am abc companney 1 . hosting 2.domina',
        options: {
          '1': {
            text: 'hosting  https://abccompanney.com',
          },
          '2': {
            text: 'domina https://abccompanney.com/domina',
          },
        },
      },
      'xyz-company': {
        enabled: true,
        trigger: '', // any message triggers
        greeting: 'xyz companney hi i am xyz companney 1 . blog 2.support',
        options: {
          '1': {
            text: 'blog https://xyzcompanney.com/bloh',
          },
          '2': {
            text: 'support https://xyzcompanney.com/support',
            options: {
              '1': {
                text: 'support ticket created',
              },
            },
          },
        },
      },
      'disabled-company': {
        enabled: false,
        trigger: 'hi',
        greeting: 'hello from disabled',
      },
    },
  };

  beforeEach(() => {
    mockStorage = {
      config: testConfig,
    };
    replyMock = jest.fn().mockResolvedValue({ messageId: 'reply-123' });

    context = {
      pluginId: 'auto-reply',
      storage: {
        get: jest.fn().mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null)),
        set: jest.fn().mockImplementation((key: string, val: any) => {
          mockStorage[key] = val;
          return Promise.resolve();
        }),
        delete: jest.fn().mockImplementation((key: string) => {
          delete mockStorage[key];
          return Promise.resolve();
        }),
        list: jest.fn(),
      },
      messages: {
        reply: replyMock,
        sendText: jest.fn(),
      },
      logger: {
        log: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    } as unknown as PluginContext;
  });

  it('does nothing if session config does not exist or is disabled', async () => {
    let result = await FlowEngine.processMessage(context, 'unknown-company', 'user1', 'hi', 'msg1');
    expect(result).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();

    result = await FlowEngine.processMessage(context, 'disabled-company', 'user1', 'hi', 'msg1');
    expect(result).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('triggers greeting message on trigger word matches (case-insensitive)', async () => {
    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', '  HI  ', 'msg1');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('abc-company', 'user1', 'msg1', testConfig.sessions!['abc-company'].greeting);
    expect(mockStorage['state__abc-company__user1']).toBeDefined();
    expect(mockStorage['state__abc-company__user1'].path).toEqual([]);
  });

  it('does not trigger greeting if trigger does not match', async () => {
    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', 'something else', 'msg1');
    expect(result).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
    expect(mockStorage['state__abc-company__user1']).toBeUndefined();
  });

  it('triggers greeting on any word if trigger is empty', async () => {
    const result = await FlowEngine.processMessage(context, 'xyz-company', 'user1', 'anything', 'msg1');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('xyz-company', 'user1', 'msg1', testConfig.sessions!['xyz-company'].greeting);
    expect(mockStorage['state__xyz-company__user1'].path).toEqual([]);
  });

  it('advances state and replies with selection, then ends if leaf node is reached', async () => {
    // Start flow
    await FlowEngine.processMessage(context, 'abc-company', 'user1', 'hi', 'msg1');
    replyMock.mockClear();

    // Select option 1
    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', '1', 'msg2');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('abc-company', 'user1', 'msg2', 'hosting  https://abccompanney.com');
    // Since option 1 is leaf, state should be deleted
    expect(mockStorage['state__abc-company__user1']).toBeUndefined();
  });

  it('stays in flow and saves state if next node is not a leaf', async () => {
    // Start flow
    await FlowEngine.processMessage(context, 'xyz-company', 'user1', 'hello', 'msg1');
    replyMock.mockClear();

    // Select option 2 (support) which has nested options
    const result = await FlowEngine.processMessage(context, 'xyz-company', 'user1', '2', 'msg2');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('xyz-company', 'user1', 'msg2', 'support https://xyzcompanney.com/support');
    expect(mockStorage['state__xyz-company__user1'].path).toEqual(['2']);

    replyMock.mockClear();
    // Select option 1 of support menu
    const result2 = await FlowEngine.processMessage(context, 'xyz-company', 'user1', '1', 'msg3');
    expect(result2).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('xyz-company', 'user1', 'msg3', 'support ticket created');
    // Leaf node reached, state is deleted
    expect(mockStorage['state__xyz-company__user1']).toBeUndefined();
  });

  it('sends invalid option message and retains state if choice does not exist', async () => {
    await FlowEngine.processMessage(context, 'abc-company', 'user1', 'hi', 'msg1');
    replyMock.mockClear();

    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', '99', 'msg2');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith(
      'abc-company',
      'user1',
      'msg2',
      `Invalid option. Please choose one of the available options:\n\n` + testConfig.sessions!['abc-company'].greeting
    );
    expect(mockStorage['state__abc-company__user1'].path).toEqual([]);
  });

  it('resets flow state if trigger word is sent while already inside a flow', async () => {
    await FlowEngine.processMessage(context, 'abc-company', 'user1', 'hi', 'msg1');
    mockStorage['state__abc-company__user1'].path = ['1']; // simulate some path
    replyMock.mockClear();

    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', 'hi', 'msg2');
    expect(result).toBe(true);
    expect(replyMock).toHaveBeenCalledWith('abc-company', 'user1', 'msg2', testConfig.sessions!['abc-company'].greeting);
    expect(mockStorage['state__abc-company__user1'].path).toEqual([]);
  });

  it('expires state when timeout is exceeded', async () => {
    await FlowEngine.processMessage(context, 'abc-company', 'user1', 'hi', 'msg1');
    // Backdate lastActive by 20 minutes
    mockStorage['state__abc-company__user1'].lastActive = Date.now() - 20 * 60 * 1000;
    replyMock.mockClear();

    // Send a message that would normally select menu option '1', but state should be expired and ignored (or restarted if it matches trigger)
    const result = await FlowEngine.processMessage(context, 'abc-company', 'user1', '1', 'msg2');
    expect(result).toBe(false); // input '1' is not trigger, so flow is ignored
    expect(replyMock).not.toHaveBeenCalled();
    expect(mockStorage['state__abc-company__user1']).toBeUndefined();
  });
});
