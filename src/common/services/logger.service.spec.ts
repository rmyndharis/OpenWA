import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { LoggerService, LogLevel, LogFormat, createLogger } from './logger.service';
import { runWithRequestId } from './request-context';

interface LogEntry {
  timestamp: string;
  level: string;
  context: string;
  message: string;
  sessionId?: string;
  action?: string;
  trace?: string;
}

// Helper to safely extract log output from mock calls
function getLogOutput(spy: jest.SpyInstance): LogEntry {
  const calls = spy.mock.calls as string[][];
  return JSON.parse(calls[0][0]) as LogEntry;
}

// Helper to read the raw (unparsed) string a spy was called with.
function getRawOutput(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as string[][];
  return calls[0][0];
}

describe('LoggerService', () => {
  let logger: LoggerService;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new LoggerService();
    logger.setContext('TestContext');
    // Pin JSON so structured-output assertions are deterministic regardless of TTY/LOG_FORMAT.
    LoggerService.setLogFormat(LogFormat.JSON);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    LoggerService.setLogFormat(null);
    LoggerService.setLogLevel(LogLevel.INFO);
  });

  describe('log', () => {
    it('should log info messages with context', () => {
      logger.log('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const output = getLogOutput(consoleSpy);
      expect(output.level).toBe('info');
      expect(output.message).toBe('Test message');
      expect(output.context).toBe('TestContext');
      expect(output.timestamp).toBeDefined();
    });

    it('should log with additional metadata', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getLogOutput(consoleSpy);
      expect(output.sessionId).toBe('123');
      expect(output.action).toBe('test');
    });
  });

  describe('secret redaction', () => {
    it('redacts the values of secret-named keys in the metadata', () => {
      logger.log('auth', { password: 'hunter2', apiKey: 'abc123', userId: 'u1' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.password).toBe('[REDACTED]');
      expect(output.apiKey).toBe('[REDACTED]');
      expect(output.userId).toBe('u1');
    });

    it('redacts secret-named keys nested inside the metadata', () => {
      logger.log('cfg', { config: { redisPassword: 'p', host: 'h' } });

      const output = getLogOutput(consoleSpy) as unknown as { config: { redisPassword: string; host: string } };
      expect(output.config.redisPassword).toBe('[REDACTED]');
      expect(output.config.host).toBe('h');
    });
  });

  describe('error', () => {
    it('should log error messages to console.error', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace');

      expect(errorSpy).toHaveBeenCalled();
      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('Error message');
      expect(output.trace).toBe('stack trace');
    });
  });

  // Plugin ctx.logger meta reaches the logger verbatim, so caller metadata must not be able to rewrite
  // the fields a reader trusts to say who logged what, at which level.
  describe('structural fields', () => {
    it('keeps level, context, message, timestamp, trace and requestId out of reach of caller metadata', () => {
      logger.log('[plugin-a] hi', {
        level: 'error',
        context: 'AuthService',
        message: 'API key rotated',
        timestamp: '1970-01-01T00:00:00.000Z',
        trace: 'forged stack',
        requestId: 'forged',
        pluginId: 'plugin-a',
      });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.level).toBe('info');
      expect(output.context).toBe('TestContext');
      expect(output.message).toBe('[plugin-a] hi');
      expect(output.timestamp).not.toBe('1970-01-01T00:00:00.000Z');
      expect(output).not.toHaveProperty('trace');
      expect(output).not.toHaveProperty('requestId');
      expect(output.pluginId).toBe('plugin-a');
    });

    it("still takes error()'s trace and string context from its own parameters", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', 'OtherContext');

      const output = getLogOutput(errorSpy);
      expect(output.context).toBe('OtherContext');
      expect(output.trace).toBe('real stack');
    });

    it("keeps error()'s own trace over one smuggled in its metadata", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', { trace: 'forged stack', sessionId: 's1' });

      const output = getLogOutput(errorSpy);
      expect(output.trace).toBe('real stack');
      expect(output.context).toBe('TestContext');
      expect(output.sessionId).toBe('s1');
    });
  });

  describe('warn', () => {
    it('should log warning messages to console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn');
      logger.warn('Warning message');

      expect(warnSpy).toHaveBeenCalled();
      const output = getLogOutput(warnSpy);
      expect(output.level).toBe('warn');
      expect(output.message).toBe('Warning message');
    });
  });

  describe('log levels', () => {
    it('should not log debug when level is INFO', () => {
      LoggerService.setLogLevel(LogLevel.INFO);
      logger.debug('Debug message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log debug when level is DEBUG', () => {
      LoggerService.setLogLevel(LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('pretty format', () => {
    beforeEach(() => {
      LoggerService.setLogFormat(LogFormat.PRETTY);
    });

    it('should render a NestJS-style human-readable line instead of JSON', () => {
      logger.log('Test message');

      const output = getRawOutput(consoleSpy);
      // Not JSON.
      expect(() => {
        JSON.parse(output);
      }).toThrow();
      // NestJS-style prefix, level label, context and message all present.
      expect(output).toContain('[OpenWA]');
      expect(output).toContain('LOG');
      expect(output).toContain('[TestContext]');
      expect(output).toContain('Test message');
    });

    it('should append metadata as key=value pairs', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getRawOutput(consoleSpy);
      expect(output).toContain('sessionId=123');
      expect(output).toContain('action=test');
    });

    it('should append the stack trace on a new line for errors', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace line');

      const output = getRawOutput(errorSpy);
      expect(output).toContain('Error message');
      expect(output).toContain('stack trace line');
      expect(output).toMatch(/\n.*stack trace line/);
    });
  });

  describe('non-string input (the call shapes Nest uses)', () => {
    it('renders an Error passed as the message with its stack as the trace', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error(new Error('boom'));

      const output = getLogOutput(errorSpy);
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.trace).toMatch(/\n\s+at /);
    });

    it('turns an Error or other value passed as the trace into a string', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('failed', new Error('inner'));
      logger.error('failed', 42);

      const calls = errorSpy.mock.calls as string[][];
      expect((JSON.parse(calls[0][0]) as LogEntry).trace).toContain('Error: inner');
      expect((JSON.parse(calls[1][0]) as LogEntry).trace).toBe('42');
    });

    it('serializes an object message with secret-named keys redacted', () => {
      logger.log({ a: 1, password: 'p' });

      expect(getLogOutput(consoleSpy).message).toBe('{"a":1,"password":"[REDACTED]"}');
    });

    it('does not throw on a circular object message', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => logger.log(circular)).not.toThrow();
      expect(typeof getLogOutput(consoleSpy).message).toBe('string');
    });

    it('writes fatal() at error level', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.fatal('down');

      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('down');
    });
  });

  describe('as the Nest framework logger', () => {
    beforeEach(() => {
      Logger.overrideLogger(createLogger('Nest'));
    });
    afterEach(() => {
      Logger.overrideLogger(new ConsoleLogger());
    });

    it("keeps the exception handler's message, stack, context and request id", () => {
      const errorSpy = jest.spyOn(console, 'error');
      runWithRequestId('req-1', () => new Logger('ExceptionsHandler').error(new Error('boom')));

      const output = getLogOutput(errorSpy) as LogEntry & { requestId?: string };
      expect(output.context).toBe('ExceptionsHandler');
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.requestId).toBe('req-1');
    });

    it('applies LOG_LEVEL to framework lines', () => {
      new Logger('X').debug('d');
      expect(consoleSpy).not.toHaveBeenCalled();

      new Logger('X').log('m');
      expect(getLogOutput(consoleSpy).context).toBe('X');
    });
  });

  // Without the option Nest keeps its ConsoleLogger, which ignores LOG_LEVEL and LOG_FORMAT.
  it('is installed as the framework logger by main.ts', () => {
    const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    expect(mainSrc).toMatch(/await NestFactory\.create\(AppModule, \{[^}]*\blogger: createLogger\('Nest'\)/);
  });

  describe('createLogger', () => {
    it('should create logger with context', () => {
      const testLogger = createLogger('MyContext');
      testLogger.log('Test');

      const output = getLogOutput(consoleSpy);
      expect(output.context).toBe('MyContext');
    });
  });
});
