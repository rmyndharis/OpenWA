import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** The opening paragraph that says which gateway release each SDK addition needs (docs/18 quotes it). */
const requirementsParagraph = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .map(line => line.replace(/^>\s*/, ''))
    .find(line => line.startsWith('This document describes')) ?? '';

describe('SDK compatibility note', () => {
  // The JavaScript, Python, Go and Java types send these two customLinkPreview fields, and a gateway at
  // 0.26.0 refuses each one with 400: its CustomLinkPreviewDto carries only url, title and description,
  // and the global ValidationPipe runs with forbidNonWhitelisted. The note that lists the additions
  // needing a newer gateway has to name them. The PHP SDK takes a raw body with no preview shape.
  const PREVIEW_IMAGE_FIELDS = ['thumbnailUrl', 'thumbnailBase64'];

  it.each([
    'sdk/README.md',
    'sdk/javascript/README.md',
    'sdk/python/README.md',
    'sdk/go/README.md',
    'sdk/java/README.md',
    'docs/18-sdk-design.md',
  ])('%s names the customLinkPreview image fields among the additions that need a newer gateway', path => {
    const paragraph = requirementsParagraph(path).toLowerCase();
    expect(paragraph).not.toBe('');
    expect(PREVIEW_IMAGE_FIELDS.filter(field => !paragraph.includes(field.toLowerCase()))).toEqual([]);
  });
});
