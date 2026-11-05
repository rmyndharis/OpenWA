import { ChildProcess, execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { get } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * The real src/main.ts, booted through ts-node in a scratch working directory with a minimal environment, and
 * what process signals do to it. Signals only ever go to the child this file started.
 *
 * Why the gateway must not listen on the fault signals: a JavaScript listener on SIGSEGV, SIGBUS, SIGILL,
 * SIGFPE or SIGTRAP turns a synchronous fault in native code into a process that spins at full CPU, because the
 * faulting instruction runs again once the handler returns and the event loop never gets to run the listener.
 * Without a listener the default action ends the process, and the restart policy brings the gateway back.
 */
const repo = resolve(__dirname, '..');
const tsNode = require.resolve('ts-node/register/transpile-only', { paths: [repo] });

const WATCHED = [
  'SIGHUP',
  'SIGINT',
  'SIGTERM',
  'SIGQUIT',
  'SIGABRT',
  'SIGUSR2',
  'SIGILL',
  'SIGTRAP',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV',
];

// Runs inside the gateway before main.ts. Once /api/health/live answers, every process.on() of the boot has
// happened, so it records the listener counts, and then loads the native library of a fault case or reads
// past the end of a WebAssembly memory. Once the WRITE_MARKER file exists it writes a log line every 50 ms,
// the way the gateway's logger does.
const PRELOAD = `
const http = require('http');
const fs = require('fs');
const timer = setInterval(() => {
  http.get({ host: '127.0.0.1', port: process.env.PORT, path: '/api/health/live' }, res => {
    res.resume();
    if (res.statusCode !== 200 || fs.existsSync(process.env.LISTENERS_FILE)) return;
    clearInterval(timer);
    const counts = {};
    for (const signal of JSON.parse(process.env.WATCHED_SIGNALS)) counts[signal] = process.listenerCount(signal);
    fs.writeFileSync(process.env.LISTENERS_FILE + '.tmp', JSON.stringify(counts));
    fs.renameSync(process.env.LISTENERS_FILE + '.tmp', process.env.LISTENERS_FILE);
    if (process.env.FAULT_LIB) setTimeout(() => process.dlopen({ exports: {} }, process.env.FAULT_LIB), 50);
    if (process.env.WASM_OUTCOME_FILE) setTimeout(() => {
      // (module (memory 1) (func (export "f") (result i32) i32.const 100000 i32.load)): a read past the one page.
      const bytes = Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00,
        0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x0b, 0x01, 0x09, 0x00, 0x41, 0xa0,
        0x8d, 0x06, 0x28, 0x02, 0x00, 0x0b,
      ]);
      const { f } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
      let outcome = 'no trap';
      try { f(); } catch (error) { outcome = error.constructor.name; }
      fs.writeFileSync(process.env.WASM_OUTCOME_FILE, outcome);
    }, 50);
  }).on('error', () => {});
}, 100);
timer.unref();
if (process.env.WRITE_MARKER) {
  const writer = setInterval(() => {
    if (fs.existsSync(process.env.WRITE_MARKER)) console.log('a log line for an output that is gone');
  }, 50);
  writer.unref();
}
`;

type Outcome = { code: number | null; signal: NodeJS.Signals | null };

interface Gateway {
  child: ChildProcess;
  port: number;
  cwd: string;
  /** process.listenerCount per watched signal, read inside the process once it answered /api/health/live. */
  listeners: Record<string, number>;
  exited: Promise<Outcome>;
  /** Everything the process has written to stdout and stderr so far. */
  output: () => string;
}

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

/** The outcome of `promise`, or `onTimeout` when it has not settled within `ms`. */
function within<T, U>(promise: Promise<T>, ms: number, onTimeout: U): Promise<T | U> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<U>(res => {
    timer = setTimeout(() => res(onTimeout), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => res(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** The status and JSON body of a GET, or an empty status when the connection fails. */
function probe(port: number, path: string): Promise<{ status?: number; body: unknown }> {
  return new Promise(res => {
    const request = get({ host: '127.0.0.1', port, path, timeout: 1000 }, response => {
      let text = '';
      response.on('data', (chunk: Buffer) => (text += chunk.toString()));
      response.on('end', () => {
        try {
          res({ status: response.statusCode, body: JSON.parse(text) });
        } catch {
          res({ status: response.statusCode, body: text });
        }
      });
    });
    request.on('error', () => res({ body: undefined }));
    request.on('timeout', () => request.destroy());
  });
}

function hasCompiler(): boolean {
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the two native fault cases do. They need a C compiler. Without one they skip, except under GitHub
 * Actions: a runner that lost its compiler would report green on cases it never ran, unnoticed among the tests
 * that skip. Keyed on GITHUB_ACTIONS rather than CI, which a local shell may export without a compiler.
 */
function nativeFaultMode(compilerFound: boolean, githubActions: string | undefined): 'run' | 'fail' | 'skip' {
  if (compilerFound) return 'run';
  return githubActions === 'true' ? 'fail' : 'skip';
}

// Signals other than SIGTERM and SIGINT are not delivered to a process the same way on Windows.
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const nativeFaults = nativeFaultMode(hasCompiler(), process.env.GITHUB_ACTIONS);
const runWithCompiler = nativeFaults === 'skip' ? it.skip : it;

describe('the native fault cases without a C compiler', () => {
  it.each([
    { compilerFound: true, githubActions: undefined, mode: 'run' },
    { compilerFound: true, githubActions: 'true', mode: 'run' },
    { compilerFound: false, githubActions: undefined, mode: 'skip' },
    { compilerFound: false, githubActions: 'false', mode: 'skip' },
    { compilerFound: false, githubActions: 'true', mode: 'fail' },
  ])(
    '$mode with compilerFound $compilerFound and GITHUB_ACTIONS $githubActions',
    ({ compilerFound, githubActions, mode }) => {
      expect(nativeFaultMode(compilerFound, githubActions)).toBe(mode);
    },
  );
});

describePosix('process signals on the running gateway', () => {
  let root: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'openwa-signals-'));
  });

  afterAll(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Boots src/main.ts and resolves once the process has answered /api/health/live. */
  async function boot(extraEnv: Record<string, string> = {}): Promise<Gateway> {
    const dir = mkdtempSync(join(root, 'run-'));
    const cwd = join(dir, 'app');
    mkdirSync(cwd);
    const preload = join(dir, 'preload.js');
    const listenersFile = join(dir, 'listeners.json');
    writeFileSync(preload, PRELOAD);
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', tsNode, '-r', preload, join(repo, 'src', 'main.ts')], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'test',
        PORT: String(port),
        UPDATE_CHECK_ENABLED: 'false',
        SERVE_DASHBOARD: 'false',
        LOG_FORMAT: 'json',
        LOG_LEVEL: 'info',
        TS_NODE_PROJECT: join(repo, 'tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true',
        LISTENERS_FILE: listenersFile,
        WATCHED_SIGNALS: JSON.stringify(WATCHED),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let written = '';
    child.stdout?.on('data', (chunk: Buffer) => (written += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (written += chunk.toString()));
    const exited = new Promise<Outcome>(res => child.once('exit', (code, signal) => res({ code, signal })));

    const deadline = Date.now() + 60_000;
    while (
      !existsSync(listenersFile) &&
      Date.now() < deadline &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await sleep(100);
    }
    if (!existsSync(listenersFile)) {
      throw new Error(
        `the gateway did not come up: ${JSON.stringify(await within(exited, 0, 'running'))}\n${written.slice(-800)}`,
      );
    }
    const listeners = JSON.parse(readFileSync(listenersFile, 'utf8')) as Record<string, number>;
    return { child, port, cwd, listeners, exited, output: () => written };
  }

  /** Sends SIGHUP and reports the readiness it answered first, then how the process ended. */
  async function hangUp(gateway: Gateway) {
    let ended = false;
    void gateway.exited.then(() => (ended = true));

    gateway.child.kill('SIGHUP');
    let readiness: { status?: number; body: unknown } = { body: undefined };
    for (let polls = 0; polls < 400 && !ended && readiness.status !== 503; polls++) {
      readiness = await probe(gateway.port, '/api/health/ready');
      if (readiness.status !== 503) await sleep(25);
    }
    const outcome = await within(gateway.exited, 30_000, 'still running' as const);

    const body = readiness.body as { details?: { shutdown?: { status?: string } } } | undefined;
    return { readiness: readiness.status, draining: body?.details?.shutdown?.status, outcome };
  }

  describe('after boot', () => {
    let gateway: Gateway;

    // A grace long enough to read the draining readiness, short enough for a test.
    beforeAll(async () => {
      gateway = await boot({ SHUTDOWN_DELAY_MS: '1500' });
    }, 120_000);

    it('listens only for the stop signals and leaves every other one to its default action', () => {
      expect(gateway.listeners).toEqual({
        SIGHUP: 1,
        SIGINT: 1,
        SIGTERM: 1,
        SIGQUIT: 0,
        SIGABRT: 0,
        SIGUSR2: 0,
        SIGILL: 0,
        SIGTRAP: 0,
        SIGBUS: 0,
        SIGFPE: 0,
        SIGSEGV: 0,
      });
    });

    it('drains on SIGHUP like on SIGTERM: readiness answers 503 first, then it exits 0', async () => {
      expect(await hangUp(gateway)).toEqual({
        readiness: 503,
        draining: 'draining',
        outcome: { code: 0, signal: null },
      });
      expect(gateway.output()).toContain('Entering draining state');
    }, 60_000);
  });

  describe('with its log output gone', () => {
    // A closed terminal or a dead parent fails the next log write with EIO or EPIPE. Unhandled, that ends the
    // process at the first log line after the grace, so the teardown never runs and the exit status is 1.
    it('still finishes the drain on SIGHUP and exits 0', async () => {
      const gateway = await boot({ SHUTDOWN_DELAY_MS: '1500' });
      gateway.child.stdout?.destroy();
      gateway.child.stderr?.destroy();

      expect(await hangUp(gateway)).toEqual({
        readiness: 503,
        draining: 'draining',
        outcome: { code: 0, signal: null },
      });
    }, 120_000);

    // Only the stop path absorbs those errors: a gateway that is not stopping still ends on a lost log sink.
    it('still ends the process when the output goes away before any stop signal', async () => {
      const marker = join(root, 'write-marker');
      const gateway = await boot({ WRITE_MARKER: marker });
      gateway.child.stdout?.destroy();
      gateway.child.stderr?.destroy();
      writeFileSync(marker, '');

      expect(await within(gateway.exited, 30_000, 'still running' as const)).toEqual({ code: 1, signal: null });
    }, 120_000);
  });

  describe('with the diagnostic report signal enabled', () => {
    // The directory is part of the setup because the image's working directory cannot be written, and a report
    // that cannot be written is lost: docs/11 names --report-directory for that reason.
    it('writes the report to its directory on SIGUSR2 and keeps running', async () => {
      const reports = mkdtempSync(join(root, 'reports-'));
      const gateway = await boot({
        NODE_OPTIONS: `--report-on-signal --report-directory=${reports}`,
        SHUTDOWN_DELAY_MS: '0',
      });

      gateway.child.kill('SIGUSR2');
      const reportWritten = async (): Promise<boolean> => {
        for (let polls = 0; polls < 200; polls++) {
          if (readdirSync(reports).some(file => file.startsWith('report.') && file.endsWith('.json'))) return true;
          await sleep(50);
        }
        return false;
      };
      const written = await reportWritten();
      const live = await probe(gateway.port, '/api/health/live');
      const stillRunning = gateway.child.exitCode === null && gateway.child.signalCode === null;
      gateway.child.kill('SIGTERM');
      const outcome = await within(gateway.exited, 30_000, 'still running' as const);

      expect({ written, live: live.status, stillRunning, outcome }).toEqual({
        written: true,
        live: 200,
        stillRunning: true,
        outcome: { code: 0, signal: null },
      });
    }, 120_000);
  });

  describe('a WebAssembly trap on the main thread', () => {
    // The Baileys engine runs WebAssembly inside the gateway. V8 turns an out-of-bounds access into a catchable
    // RuntimeError through its own SIGSEGV handler; a JavaScript listener on SIGSEGV or SIGBUS replaces that
    // handler, and the access then faults again and again at full CPU with nothing in the log.
    it('raises a catchable error in the running gateway instead of spinning it', async () => {
      const outcomeFile = join(root, 'wasm-outcome');
      const gateway = await boot({ WASM_OUTCOME_FILE: outcomeFile });

      let outcome = 'the process hung';
      for (let polls = 0; polls < 200; polls++) {
        if (existsSync(outcomeFile)) {
          outcome = readFileSync(outcomeFile, 'utf8');
          break;
        }
        await sleep(50);
      }
      gateway.child.kill('SIGKILL');

      expect(outcome).toBe('RuntimeError');
    }, 120_000);
  });

  describe('a native fault on the main thread', () => {
    const faults = [
      { what: 'a write through a null pointer', body: 'volatile int *p = (int *)0; *p = 1;', ends: /^SIG(SEGV|BUS)$/ },
      // The trap instruction is how V8 ends on a fatal error: SIGTRAP on arm64, SIGILL on x86_64.
      { what: 'a trap instruction', body: '__builtin_trap();', ends: /^SIG(TRAP|ILL)$/ },
    ];

    for (const fault of faults) {
      runWithCompiler(
        `ends the process by its signal after ${fault.what}, instead of leaving it spinning`,
        async () => {
          if (nativeFaults === 'fail') throw new Error('a C compiler (cc) is required under GitHub Actions');
          const dir = mkdtempSync(join(root, 'fault-'));
          const source = join(dir, 'fault.c');
          const lib = join(dir, process.platform === 'darwin' ? 'fault.dylib' : 'fault.so');
          writeFileSync(source, `__attribute__((constructor)) static void fault(void) { ${fault.body} }\n`);
          execFileSync('cc', ['-shared', '-fPIC', '-o', lib, source]);
          const gateway = await boot({ FAULT_LIB: lib });

          const outcome = await within(gateway.exited, 20_000, 'still running' as const);
          if (outcome === 'still running') gateway.child.kill('SIGKILL');

          expect(outcome === 'still running' ? outcome : (outcome.signal ?? `exit code ${outcome.code}`)).toMatch(
            fault.ends,
          );
        },
        120_000,
      );
    }
  });
});
