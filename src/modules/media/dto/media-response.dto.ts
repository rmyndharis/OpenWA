import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shapes for the media conversion routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class ConversionStatusResponseDto {
  @ApiProperty({
    description:
      'True only when conversion is switched on AND the ffmpeg binary is runnable. False means a ' +
      'convert call will be refused, so check this before offering conversion in a UI.',
    example: true,
  })
  available!: boolean;
}

export class ConvertedMediaResponseDto {
  @ApiProperty({
    description: "The converted bytes, ready to hand straight to a send endpoint's `base64` field.",
    example: 'T2dnUwACAAAAAAAAAAA...',
  })
  base64!: string;

  @ApiProperty({
    description: 'The type the bytes now are — not the type they were.',
    example: 'audio/ogg; codecs=opus',
  })
  mimetype!: string;

  @ApiProperty({ description: 'Decoded size, so a caller can check a send limit without decoding.', example: 20480 })
  bytes!: number;
}
