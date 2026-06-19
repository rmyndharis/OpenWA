export const LLM_PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GROQ: 'groq',
  OLLAMA: 'ollama',
} as const;

export type LlmProviderName = (typeof LLM_PROVIDERS)[keyof typeof LLM_PROVIDERS];

export const LLM_DEFAULT_MODELS: Record<LlmProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  groq: 'llama-3.1-8b-instant',
  ollama: 'llama3.2',
};

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
