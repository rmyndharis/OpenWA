import { compareSemver, annotateCatalog, CatalogEntry } from './catalog';

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
});
