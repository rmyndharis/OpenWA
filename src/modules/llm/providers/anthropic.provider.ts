import Anthropic from '@anthropic-ai/sdk';
import { ILlmProvider, LlmMessage, LlmOptions, LlmResponse } from '../interfaces/llm-provider.interface';

export class AnthropicProvider implements ILlmProvider {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly defaultModel: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const response = await this.client.messages.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 1024,
      ...(systemMsg && { system: systemMsg.content }),
      messages: chatMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    });

    const textBlock = response.content.find(b => b.type === 'text');

    return {
      content: textBlock?.type === 'text' ? textBlock.text : '',
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }

  async embed(_text: string): Promise<number[]> {
    throw new Error('Anthropic does not support embeddings. Use OpenAI or Ollama for semantic search.');
  }
}
