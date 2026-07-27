import 'reflect-metadata';
import { validate } from 'class-validator';
import { InstallFromUrlDto } from './plugin.dto';

/**
 * The install/update-from-URL boundary: plugin packages are executable code, so the download must
 * be integrity-protected in transit. Plain http:// is rejected with a clear message; https:// —
 * including an optional `#sha256=` integrity fragment — passes DTO validation (private-network
 * targets remain subject to the SSRF guard downstream).
 */
describe('InstallFromUrlDto', () => {
  const dtoWith = (url: string): InstallFromUrlDto => {
    const dto = new InstallFromUrlDto();
    dto.url = url;
    return dto;
  };

  it('rejects a plain http:// URL with a clear message', async () => {
    const errors = await validate(dtoWith('http://plugins.example/pkg.zip'));

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('url');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/https:\/\/ URL.*plain http is not accepted/i);
  });

  it('rejects http:// even for a localhost/private host (no scheme carve-out)', async () => {
    const errors = await validate(dtoWith('http://localhost:3000/pkg.zip'));

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('url');
  });

  it('accepts an https:// URL', async () => {
    await expect(validate(dtoWith('https://plugins.example/pkg.zip'))).resolves.toHaveLength(0);
  });

  it('accepts an https:// URL carrying a #sha256 integrity fragment', async () => {
    const digest = 'a'.repeat(64);
    await expect(validate(dtoWith(`https://plugins.example/pkg.zip#sha256=${digest}`))).resolves.toHaveLength(0);
  });

  it('rejects a non-URL value', async () => {
    const errors = await validate(dtoWith('not-a-url'));

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('url');
  });
});
