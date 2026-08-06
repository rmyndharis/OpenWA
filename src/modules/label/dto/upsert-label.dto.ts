import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';

/**
 * The body of a label create-or-update. The id is the path parameter, not a field: WhatsApp keys the
 * write on it, and taking it from the URL is what makes `PUT` the honest verb here.
 */
export class UpsertLabelDto {
  @ApiPropertyOptional({
    description: 'Label name. Omit to leave the current name untouched.',
    example: 'VIP customer',
    minLength: 1,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  // WhatsApp's own label editor caps names well below this; the bound exists so a runaway payload
  // cannot be written into app-state, not because 100 is a protocol limit.
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      "WhatsApp's colour INDEX (0-19), not a hex value — the read path's `hexColor` cannot be " +
      'translated back, because neither engine exposes the mapping. Omit to leave the colour alone.',
    example: 3,
    minimum: 0,
    maximum: 19,
  })
  // The global pipe runs with implicit conversion, and Number('') is 0 — which here is a REAL
  // colour, so a blank field would silently recolour the label instead of being refused.
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  // WhatsApp defines exactly 20 predefined label colours (baileys LabelColor, Types/Label.d.ts).
  @Max(19)
  color?: number;
}
