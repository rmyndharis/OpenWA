import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OpenAiSttProvider, LocalWhisperSttProvider, TranscriptionResult } from './providers/openai-stt.provider';
import { TesseractOcrProvider, OcrResult } from './providers/tesseract-ocr.provider';
import { OpenAiModerationProvider, ModerationResult } from './providers/openai-moderation.provider';
import { createLogger } from '../../common/services/logger.service';

@Injectable()
export class MediaAiService {
  private readonly logger = createLogger('MediaAiService');
  private readonly sttProvider: OpenAiSttProvider | LocalWhisperSttProvider | null;
  private readonly ocrProvider: TesseractOcrProvider | null;
  private readonly visionClient: OpenAI | null;
  private readonly moderationProvider: OpenAiModerationProvider | null;
  private readonly ocrConfidenceThreshold: number;
  private readonly visionModel: string;

  constructor(configService: ConfigService) {
    const openAiKey = configService.get<string>('mediaAi.openAiApiKey', '');

    this.ocrConfidenceThreshold = configService.get<number>('mediaAi.ocrConfidenceThreshold', 60);
    this.visionModel = configService.get<string>('mediaAi.visionModel', 'gpt-4o');

    const sttProvider = configService.get<string>('mediaAi.sttProvider', 'openai');
    if (sttProvider === 'local') {
      const localUrl = configService.get<string>('mediaAi.sttLocalUrl', 'http://localhost:8080');
      this.sttProvider = new LocalWhisperSttProvider(localUrl);
    } else if (openAiKey) {
      const sttModel = configService.get<string>('mediaAi.sttModel', 'whisper-1');
      this.sttProvider = new OpenAiSttProvider(openAiKey, sttModel);
    } else {
      this.sttProvider = null;
    }

    const ocrProvider = configService.get<string>('mediaAi.ocrProvider', 'local');
    this.ocrProvider = ocrProvider === 'local' ? new TesseractOcrProvider() : null;

    this.visionClient = openAiKey ? new OpenAI({ apiKey: openAiKey }) : null;

    const moderationProvider = configService.get<string>('mediaAi.moderationProvider', 'openai');
    this.moderationProvider = moderationProvider === 'openai' && openAiKey
      ? new OpenAiModerationProvider(openAiKey)
      : null;
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (!this.sttProvider) throw new Error('STT provider not configured');
    return this.sttProvider.transcribe(audioBuffer, mimeType);
  }

  async extractText(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.ocrProvider) throw new Error('OCR provider not configured');

    const result = await this.ocrProvider.extractText(imageBuffer);
    if (result.confidence < this.ocrConfidenceThreshold && this.visionClient) {
      this.logger.debug(`Low OCR confidence ${result.confidence}, falling back to vision`);
      return this.extractTextViaVision(imageBuffer);
    }
    return result;
  }

  async describeImage(imageBuffer: Buffer): Promise<string> {
    if (!this.visionClient) throw new Error('Vision provider not configured');

    const base64 = imageBuffer.toString('base64');
    const response = await this.visionClient.chat.completions.create({
      model: this.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: 'Describe this image briefly in one or two sentences.' },
          ],
        },
      ],
      max_tokens: 200,
    });

    return response.choices[0]?.message?.content ?? '';
  }

  async moderateImage(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
    if (!this.moderationProvider) throw new Error('Moderation provider not configured');
    return this.moderationProvider.moderateImage(imageBuffer, mimeType);
  }

  isSttConfigured(): boolean { return this.sttProvider !== null; }
  isOcrConfigured(): boolean { return this.ocrProvider !== null || this.visionClient !== null; }
  isModerationConfigured(): boolean { return this.moderationProvider !== null; }

  private async extractTextViaVision(imageBuffer: Buffer): Promise<OcrResult> {
    const base64 = imageBuffer.toString('base64');
    const response = await this.visionClient!.chat.completions.create({
      model: this.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: 'Extract all text from this image. Return only the text, nothing else.' },
          ],
        },
      ],
      max_tokens: 1000,
    });

    const text = response.choices[0]?.message?.content ?? '';
    return { text, confidence: 95 }; // Vision is high-confidence
  }
}
