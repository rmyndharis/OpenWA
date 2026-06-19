import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ILlmProvider, LlmMessage, LlmOptions, LlmResponse } from './interfaces/llm-provider.interface';
import { LLM_DEFAULT_MODELS, LLM_PROVIDERS } from './llm.config';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GroqProvider } from './providers/groq.provider';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAIProvider } from './providers/openai.provider';

@Injectable()
export class LlmService {
  private readonly provider: ILlmProvider | null;

  constructor(configService: ConfigService) {
    const providerName = configService.get<string>('llm.provider', '');
    const apiKey = configService.get<string>('llm.apiKey', '');
    const model = configService.get<string>('llm.model', '');
    const baseUrl = configService.get<string>('llm.baseUrl', '');

    this.provider = LlmService.buildProvider(providerName, apiKey, model, baseUrl);
  }

  private static buildProvider(
    providerName: string,
    apiKey: string,
    model: string,
    baseUrl: string,
  ): ILlmProvider | null {
    switch (providerName) {
      case LLM_PROVIDERS.OPENAI:
        if (!apiKey) return null;
        return new OpenAIProvider(apiKey, model || LLM_DEFAULT_MODELS.openai);

      case LLM_PROVIDERS.ANTHROPIC:
        if (!apiKey) return null;
        return new AnthropicProvider(apiKey, model || LLM_DEFAULT_MODELS.anthropic);

      case LLM_PROVIDERS.GROQ:
        if (!apiKey) return null;
        return new GroqProvider(apiKey, model || LLM_DEFAULT_MODELS.groq);

      case LLM_PROVIDERS.OLLAMA:
        return new OllamaProvider(model || LLM_DEFAULT_MODELS.ollama, baseUrl || undefined);

      default:
        return null;
    }
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    if (!this.provider) {
      throw new Error('LLM provider not configured. Set LLM_PROVIDER and LLM_API_KEY environment variables.');
    }
    return this.provider.complete(messages, options);
  }

  async embed(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error('LLM provider not configured. Set LLM_PROVIDER and LLM_API_KEY environment variables.');
    }
    return this.provider.embed(text);
  }
}
