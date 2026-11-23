import { DEFAULT_PUPPETEER_ARGS } from './configuration';
import { parsePuppeteerArgs, puppeteerArgsError, validatePuppeteerArg } from './puppeteer-args';

describe('puppeteer-args allowlist', () => {
  it('allows every default Chromium launch flag', () => {
    expect(puppeteerArgsError(DEFAULT_PUPPETEER_ARGS.join(','))).toBeNull();
    expect(puppeteerArgsError(DEFAULT_PUPPETEER_ARGS.join(' '))).toBeNull();
  });

  it('allows vetted boolean and valued Chromium flags in comma- or space-separated form', () => {
    const allowed = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--mute-audio',
      '--hide-scrollbars',
      '--headless',
      '--headless=new',
      '--headless=old',
      '--lang=en-US',
      '--lang=zh-Hans-CN',
      '--window-size=1280,720',
      '--disable-features=IsolateOrigins,site-per-process',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--disable-blink-features=AutomationControlled',
      '--use-gl=swiftshader',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
    ];
    expect(puppeteerArgsError(allowed.join(' '))).toBeNull();
    expect(puppeteerArgsError(allowed.join(','))).toBeNull();
    expect(parsePuppeteerArgs('--window-size=1280,720,--disable-features=A,B --no-sandbox')).toEqual([
      '--window-size=1280,720',
      '--disable-features=A,B',
      '--no-sandbox',
    ]);
  });

  it('treats empty or whitespace-only input as unset', () => {
    expect(puppeteerArgsError('')).toBeNull();
    expect(puppeteerArgsError('   ')).toBeNull();
  });

  it.each([
    '--gpu-launcher=/bin/sh',
    '--utility-cmd-prefix=sh',
    '--renderer-cmd-prefix=sh',
    '--browser-subprocess-path=/usr/bin/python3',
    '--load-extension=/tmp/evil',
    '--disable-extensions-except=/tmp/evil',
    '--remote-debugging-port=9222',
    '--remote-debugging-address=0.0.0.0',
    '--remote-debugging-pipe',
    '--user-data-dir=/tmp/profile',
    '--disk-cache-dir=/tmp/cache',
    '--proxy-server=http://127.0.0.1:8080',
    '--proxy-pac-url=http://evil.example/pac.js',
    '--disable-web-security',
    '--ignore-certificate-errors',
    '--js-flags=--expose-gc',
    '--no-sandbox=true',
    '--lang',
    '--lang=en;rm -rf /',
    '--window-size=0,720',
    '--window-size=1280',
    '--disable-features=Foo;bar',
    '--headless=true',
    '--use-gl=custom',
    '--force-color-profile=evil',
    '--font-render-hinting=evil',
    'https://evil.example',
    '-v',
  ])('rejects disallowed or malformed token %j', bad => {
    expect(validatePuppeteerArg(bad)).toMatch(/PUPPETEER_ARGS/);
    expect(puppeteerArgsError(bad)).toMatch(/PUPPETEER_ARGS/);
  });

  it('rejects control characters and line breaks before tokenization', () => {
    expect(puppeteerArgsError('--no-sandbox\n--disable-gpu')).toMatch(/control characters/);
    expect(puppeteerArgsError('--no-sandbox\r--disable-gpu')).toMatch(/control characters/);
    expect(puppeteerArgsError('--no-sandbox\0--disable-gpu')).toMatch(/control characters/);
  });
});
