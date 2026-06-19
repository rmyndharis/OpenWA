import OpenAI from 'openai';
import { ILlmProvider, LlmMessage, LlmOptions, LlmResponse } from '../interfaces/llm-provider.interface';

const EMBED_MODEL = 'text-embedding-3-small';

export class OpenAIProvider implements ILlmProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly defaultModel: string,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  }

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: options?.model ?? this.defaultModel,
      messages,
      ...(options?.maxTokens && { max_tokens: options.maxTokens }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.jsonMode && { response_format: { type: 'json_object' } }),
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({ model: EMBED_MODEL, input: text });
    return response.data[0].embedding;
  }
}
