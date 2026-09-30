import { redisConnectionOptions } from './redis-options';

describe('redisConnectionOptions', () => {
  const KEYS = [
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_USERNAME',
    'REDIS_PASSWORD',
    'REDIS_CONNECT_TIMEOUT_MS',
    'REDIS_TLS',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to a plain connection on localhost:6379', () => {
    expect(redisConnectionOptions()).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      connectTimeout: 5000,
    });
  });

  it('maps the REDIS_* connection env', () => {
    Object.assign(process.env, {
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      REDIS_USERNAME: 'u',
      REDIS_PASSWORD: 'p',
      REDIS_CONNECT_TIMEOUT_MS: '1234',
    });
    expect(redisConnectionOptions()).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'u',
      password: 'p',
      connectTimeout: 1234,
    });
  });

  it('connects over TLS only when REDIS_TLS=true', () => {
    process.env.REDIS_TLS = 'true';
    expect(redisConnectionOptions().tls).toEqual({});
    process.env.REDIS_TLS = 'false';
    expect(redisConnectionOptions()).not.toHaveProperty('tls');
  });
});
