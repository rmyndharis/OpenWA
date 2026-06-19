import Tesseract from 'tesseract.js';

export interface OcrResult {
  text: string;
  confidence: number;
}

export class TesseractOcrProvider {
  async extractText(imageBuffer: Buffer): Promise<OcrResult> {
    const { data } = await Tesseract.recognize(imageBuffer, 'eng', {
      // ponytail: suppress logger output in production
      logger: () => undefined,
    });

    return {
      text: data.text.trim(),
      confidence: Math.round(data.confidence),
    };
  }
}
