export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface LlmResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface ILlmProvider {
  complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse>;
  embed(text: string): Promise<number[]>;
}
