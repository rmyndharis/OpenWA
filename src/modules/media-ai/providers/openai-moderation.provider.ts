import OpenAI from 'openai';

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export class OpenAiModerationProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async moderateImage(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const response = await this.client.moderations.create({
      model: 'omni-moderation-latest',
      input: [{ type: 'image_url', image_url: { url: dataUrl } }],
    });

    const result = response.results[0];
    if (!result) return { flagged: false, categories: [] };

    const flaggedCategories = Object.entries(result.categories)
      .filter(([, isFlagged]) => isFlagged)
      .map(([category]) => category);

    return {
      flagged: result.flagged,
      categories: flaggedCategories,
    };
  }
}
