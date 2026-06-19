import { GROQ_BASE_URL } from '../llm.config';
import { OpenAIProvider } from './openai.provider';

export class GroqProvider extends OpenAIProvider {
  constructor(apiKey: string, defaultModel: string) {
    super(apiKey, defaultModel, GROQ_BASE_URL);
  }

  override async embed(_text: string): Promise<number[]> {
    throw new Error('Groq does not support embeddings. Use OpenAI or Ollama for semantic search.');
  }
}
