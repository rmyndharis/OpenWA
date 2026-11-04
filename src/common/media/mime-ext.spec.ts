import { extFromMimetype } from './mime-ext';

describe('extFromMimetype', () => {
  it.each([
    ['image/png', 'png'],
    ['audio/ogg; codecs=opus', 'ogg'],
    ['IMAGE/WEBP', 'webp'],
    ['application/pdf', 'pdf'],
    ['application/constructor', 'constructor'],
    ['IMAGE/CONSTRUCTOR', 'constructor'],
  ])('uses the subtype of %s as the extension', (mimetype, ext) => {
    expect(extFromMimetype(mimetype)).toBe(ext);
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['video/quicktime', 'mov'],
  ])('maps %s to the conventional %s', (mimetype, ext) => {
    expect(extFromMimetype(mimetype)).toBe(ext);
  });

  it.each(['', 'image', 'text/', 'image/svg+xml', 'application/vnd.ms-excel', 'image/../x'])(
    'falls back to bin for %p',
    mimetype => {
      expect(extFromMimetype(mimetype)).toBe('bin');
    },
  );
});
