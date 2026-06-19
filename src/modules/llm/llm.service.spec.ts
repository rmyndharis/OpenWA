import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';
import { ILlmProvider } from './interfaces/llm-provider.interface';

const mockProvider: ILlmProvider = {
  complete: jest.fn().mockResolvedValue({
    content: 'Hello from mock',
    usage: { promptTokens: 10, completionTokens: 5 },
  }),
};

jest.mock('./providers/anthropic.provider', () => ({
  AnthropicProvider: jest.fn().mockImplementation(() => mockProvider),
}));

jest.mock('./providers/openai.provider', () => ({
  OpenAIProvider: jest.fn().mockImplementation(() => mockProvider),
}));

jest.mock('./providers/groq.provider', () => ({
  GroqProvider: jest.fn().mockImplementation(() => mockProvider),
}));

jest.mock('./providers/ollama.provider', () => ({
  OllamaProvider: jest.fn().mockImplementation(() => mockProvider),
}));

function buildService(overrides: Record<string, string> = {}): LlmService {
  const defaults: Record<string, string> = {
    'llm.provider': '',
    'llm.apiKey': '',
    'llm.model': '',
    'llm.baseUrl': '',
  };
  const config = { ...defaults, ...overrides };
  const configService = { get: (key: string, fallback = '') => config[key] ?? fallback } as unknown as ConfigService;
  return new LlmService(configService);
}

describe('LlmService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isConfigured()', () => {
    it('returns false when LLM_PROVIDER is unset', () => {
      expect(buildService().isConfigured()).toBe(false);
    });

    it('returns false when LLM_PROVIDER=openai but no API key', () => {
      expect(buildService({ 'llm.provider': 'openai' }).isConfigured()).toBe(false);
    });

    it('returns true when LLM_PROVIDER=anthropic with API key', () => {
      expect(buildService({ 'llm.provider': 'anthropic', 'llm.apiKey': 'sk-test' }).isConfigured()).toBe(true);
    });

    it('returns true for ollama without API key', () => {
      expect(buildService({ 'llm.provider': 'ollama' }).isConfigured()).toBe(true);
    });
  });

  describe('complete()', () => {
    it('throws when not configured', async () => {
      await expect(buildService().complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'LLM provider not configured',
      );
    });

    it('delegates to the provider and returns response', async () => {
      const svc = buildService({ 'llm.provider': 'anthropic', 'llm.apiKey': 'sk-test' });
      const result = await svc.complete([{ role: 'user', content: 'hi' }]);
      expect(result.content).toBe('Hello from mock');
      expect(result.usage?.promptTokens).toBe(10);
    });

    it('passes options through to provider', async () => {
      const svc = buildService({ 'llm.provider': 'anthropic', 'llm.apiKey': 'sk-test' });
      await svc.complete([{ role: 'user', content: 'hi' }], { maxTokens: 256, temperature: 0.5 });
      expect(mockProvider.complete).toHaveBeenCalledWith(
        [{ role: 'user', content: 'hi' }],
        { maxTokens: 256, temperature: 0.5 },
      );
    });
  });

  describe('module wiring', () => {
    it('resolves from NestJS DI', async () => {
      const module = await Test.createTestingModule({
        providers: [
          LlmService,
          {
            provide: ConfigService,
            useValue: { get: (_key: string, fallback = '') => fallback },
          },
        ],
      }).compile();

      const svc = module.get(LlmService);
      expect(svc).toBeInstanceOf(LlmService);
      expect(svc.isConfigured()).toBe(false);
    });
  });
});
