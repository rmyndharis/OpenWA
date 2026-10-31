import { compareSemver, annotateCatalog, isCatalogEntry, CatalogEntry } from './catalog';

describe('compareSemver', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
    expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('ignores a pre-release suffix and missing segments', () => {
    expect(compareSemver('1.2.0-beta.1', '1.2.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('garbage', '0.0.0')).toBe(0);
  });
});

describe('annotateCatalog', () => {
  const entries: CatalogEntry[] = [
    { id: 'gsheets-logger', name: 'GSheets', version: '0.3.0' },
    { id: 'faq-bot', name: 'FAQ', version: '1.0.0' },
  ];

  it('flags an installed plugin with a newer catalog version as updateAvailable', () => {
    const out = annotateCatalog(entries, [{ id: 'gsheets-logger', version: '0.2.0' }]);
    const gs = out.find(e => e.id === 'gsheets-logger')!;
    expect(gs.installed).toBe(true);
    expect(gs.installedVersion).toBe('0.2.0');
    expect(gs.updateAvailable).toBe(true);
  });

  it('does not flag updateAvailable when installed == catalog version', () => {
    const out = annotateCatalog(entries, [{ id: 'gsheets-logger', version: '0.3.0' }]);
    expect(out.find(e => e.id === 'gsheets-logger')!.updateAvailable).toBe(false);
  });

  it('marks a not-installed entry installed:false with no update', () => {
    const out = annotateCatalog(entries, [{ id: 'gsheets-logger', version: '0.3.0' }]);
    const faq = out.find(e => e.id === 'faq-bot')!;
    expect(faq.installed).toBe(false);
    expect(faq.installedVersion).toBeNull();
    expect(faq.updateAvailable).toBe(false);
  });

  it('does not flag a downgrade (installed newer than catalog) as updateAvailable', () => {
    const out = annotateCatalog(entries, [{ id: 'faq-bot', version: '2.0.0' }]);
    expect(out.find(e => e.id === 'faq-bot')!.updateAvailable).toBe(false);
  });

  it('flags the final release as an update over its own installed prerelease', () => {
    const rc = annotateCatalog(entries, [{ id: 'faq-bot', version: '1.0.0-rc.1' }]);
    expect(rc.find(e => e.id === 'faq-bot')!.updateAvailable).toBe(true);
    const prerelease = annotateCatalog(
      [{ id: 'faq-bot', name: 'FAQ', version: '1.0.0-rc.2' }],
      [{ id: 'faq-bot', version: '1.0.0' }],
    );
    expect(prerelease[0].updateAvailable).toBe(false);
    const rcToRc = annotateCatalog(
      [{ id: 'faq-bot', name: 'FAQ', version: '1.0.0-rc.2' }],
      [{ id: 'faq-bot', version: '1.0.0-rc.1' }],
    );
    expect(rcToRc[0].updateAvailable).toBe(false);
  });
});

describe('annotateCatalog with null optional fields', () => {
  it('omits a null optional field, as the published schema has it absent or a string', () => {
    const [entry] = annotateCatalog(
      [
        {
          id: 'a',
          name: 'A',
          version: '1.0.0',
          description: null,
          keywords: null,
          download: null,
          stars: null,
        } as never,
      ],
      [],
    );
    expect(entry).not.toHaveProperty('description');
    expect(entry).not.toHaveProperty('keywords');
    expect(entry).not.toHaveProperty('download');
    // Unknown extra fields are passed through as they came.
    expect(entry).toHaveProperty('stars', null);
    expect(entry).toMatchObject({ id: 'a', installed: false, updateAvailable: false });
  });
});

describe('isCatalogEntry', () => {
  const ok = { id: 'a', name: 'A', version: '1.0.0' };

  it('accepts the required fields alone, optional fields of the right type and unknown extras', () => {
    expect(isCatalogEntry(ok)).toBe(true);
    expect(isCatalogEntry({ ...ok, description: 'd', keywords: ['x'], download: 'https://x/a.zip', stars: 5 })).toBe(
      true,
    );
  });

  it('treats a null optional field as absent', () => {
    expect(isCatalogEntry({ ...ok, homepage: null, testedOpenWAVersion: null, keywords: null })).toBe(true);
  });

  it.each([
    null,
    5,
    [],
    { ...ok, id: '' },
    { ...ok, name: undefined },
    { ...ok, version: 1 },
    { ...ok, author: {} },
    { ...ok, keywords: 'x' },
    { ...ok, keywords: [1] },
  ])('rejects %j', value => {
    expect(isCatalogEntry(value)).toBe(false);
  });
});
