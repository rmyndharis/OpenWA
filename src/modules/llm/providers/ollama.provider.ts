import { OLLAMA_DEFAULT_BASE_URL } from '../llm.config';
import { OpenAIProvider } from './openai.provider';

export class OllamaProvider extends OpenAIProvider {
  constructor(defaultModel: string, baseUrl?: string) {
    const base = (baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, '');
    super('ollama', defaultModel, `${base}/v1`);
  }
}
