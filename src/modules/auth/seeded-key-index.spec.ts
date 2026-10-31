jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ActiveKeyIndex } from './active-key-index';
import { ApiKey } from './entities/api-key.entity';

describe('first-boot seeding and the active key index', () => {
  it('recognises the seeded key after bootstrap when the first index read fails', async () => {
    const savedEnv = {
      API_MASTER_KEY: process.env.API_MASTER_KEY,
      ALLOW_DEV_API_KEY: process.env.ALLOW_DEV_API_KEY,
      BOOTSTRAP_KEY_FILE: process.env.BOOTSTRAP_KEY_FILE,
    };
    delete process.env.API_MASTER_KEY;
    delete process.env.ALLOW_DEV_API_KEY;
    process.env.BOOTSTRAP_KEY_FILE = '/isolated/virtual/path/.api-key';
    let written = '';
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((_file, data) => {
      if (typeof data === 'string') written = data;
    });

    const rows: ApiKey[] = [];
    let finds = 0;
    const repository = {
      count: jest.fn(() => Promise.resolve(rows.length)),
      create: jest.fn(
        (dto: Partial<ApiKey>) => ({ ...dto, isActive: true, allowedIps: null, expiresAt: null }) as ApiKey,
      ),
      save: jest.fn((entity: ApiKey) => {
        rows.push(entity);
        return Promise.resolve(entity);
      }),
      find: jest.fn(() => {
        finds++;
        if (finds === 1) return Promise.reject(new Error('transient index read failure'));
        return Promise.resolve(rows.filter(row => row.isActive));
      }),
      findOne: jest.fn(() => Promise.resolve(null)),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        ApiKeyUsageTracker,
        ActiveKeyIndex,
        { provide: getRepositoryToken(ApiKey, 'main'), useValue: repository },
      ],
    }).compile();

    try {
      // Production order: every onModuleInit (seeding) before every onApplicationBootstrap (index load).
      await module.init();
      expect(written).toMatch(/^owa_k1_[a-f0-9]{64}$/);
      expect(module.get(ActiveKeyIndex).recognise({ 'x-api-key': written }, '192.0.2.1')).toBe(rows[0].keyHash);
    } finally {
      await module.close();
      chmodSpy.mockRestore();
      writeSpy.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
