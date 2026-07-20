import 'reflect-metadata';
import { validate, ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SetProfileNameDto, SetProfileStatusDto, SetProfilePictureDto } from './profile.dto';

// Mirror the global ValidationPipe options (src/main.ts): whitelist + forbidNonWhitelisted.
const PIPE_OPTS = { whitelist: true, forbidNonWhitelisted: true };

function errorsFor<T extends object>(cls: new () => T, payload: unknown): Promise<ValidationError[]> {
  return validate(plainToInstance(cls, payload as object), PIPE_OPTS);
}

describe('profile DTO validation', () => {
  it('requires a non-empty name within the WhatsApp limit (25)', async () => {
    expect(await errorsFor(SetProfileNameDto, { name: 'OpenWA Bot' })).toHaveLength(0);
    expect((await errorsFor(SetProfileNameDto, { name: '' })).length).toBeGreaterThan(0);
    expect((await errorsFor(SetProfileNameDto, {})).length).toBeGreaterThan(0);
    expect((await errorsFor(SetProfileNameDto, { name: 'x'.repeat(26) })).length).toBeGreaterThan(0);
  });

  it('allows an empty status (clears the about) and caps it at the WhatsApp limit (139)', async () => {
    expect(await errorsFor(SetProfileStatusDto, { status: '' })).toHaveLength(0);
    expect(await errorsFor(SetProfileStatusDto, { status: 'x'.repeat(139) })).toHaveLength(0);
    expect((await errorsFor(SetProfileStatusDto, { status: 'x'.repeat(140) })).length).toBeGreaterThan(0);
    expect((await errorsFor(SetProfileStatusDto, {})).length).toBeGreaterThan(0);
  });

  it('accepts a picture body with url or base64 (either/or is a service rule)', async () => {
    expect(await errorsFor(SetProfilePictureDto, { url: 'https://example.com/a.jpg' })).toHaveLength(0);
    expect(await errorsFor(SetProfilePictureDto, { base64: 'QUJD', mimetype: 'image/png' })).toHaveLength(0);
  });

  it('rejects a non-URL url and skips the URL check when base64 is present (#670 alignment)', async () => {
    expect((await errorsFor(SetProfilePictureDto, { url: 'not-a-url' })).length).toBeGreaterThan(0);
    expect(await errorsFor(SetProfilePictureDto, { url: 'not-a-url', base64: 'QUJD' })).toHaveLength(0);
  });

  it('rejects a non-image mimetype fast (400) — a profile picture is an image by definition', async () => {
    expect(
      (await errorsFor(SetProfilePictureDto, { base64: 'QUJD', mimetype: 'application/pdf' })).length,
    ).toBeGreaterThan(0);
    expect(await errorsFor(SetProfilePictureDto, { base64: 'QUJD', mimetype: 'image/png' })).toHaveLength(0);
  });

  it('still rejects unknown properties (forbidNonWhitelisted intact)', async () => {
    const errors = await errorsFor(SetProfilePictureDto, { base64: 'QUJD', hacker: true });
    expect(errors.some(e => e.property === 'hacker')).toBe(true);
  });
});
