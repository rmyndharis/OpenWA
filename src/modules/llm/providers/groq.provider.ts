import { GROQ_BASE_URL } from '../llm.config';
import { OpenAIProvider } from './openai.provider';

export class GroqProvider extends OpenAIProvider {
  constructor(apiKey: string, defaultModel: string) {
    super(apiKey, defaultModel, GROQ_BASE_URL);
  }
}
