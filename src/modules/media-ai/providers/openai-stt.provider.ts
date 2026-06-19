import OpenAI, { toFile } from 'openai';

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export class OpenAiSttProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const ext = this.extFromMime(mimeType);
    const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      response_format: 'verbose_json',
    });

    const verbose = response as unknown as { language?: string; duration?: number };
    return {
      text: response.text,
      language: verbose.language,
      durationMs: typeof verbose.duration === 'number' ? Math.round(verbose.duration * 1000) : undefined,
    };
  }

  private extFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'mp4',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
    };
    return map[mimeType] ?? 'ogg';
  }
}

export class LocalWhisperSttProvider {
  constructor(private readonly serverUrl: string) {}

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const formData = new FormData();
    const blob = new Blob([Buffer.from(audioBuffer) as unknown as BlobPart], { type: mimeType });
    formData.append('file', blob, 'audio.ogg');

    const response = await fetch(`${this.serverUrl}/inference`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Whisper.cpp server error: ${response.status}`);
    }

    const data = (await response.json()) as { text?: string };
    return { text: data.text ?? '' };
  }
}
