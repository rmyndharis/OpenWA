import { containsSnippet } from './search-snippet';
import { containsTerms, foldSearchText } from './search-terms';

describe('foldSearchText', () => {
  it('drops accents and lowers case, as the contains indexes compare text', () => {
    expect(foldSearchText('Meeting at the CAFÉ')).toBe('meeting at the cafe');
    expect(foldSearchText('Ação')).toBe('acao');
  });

  it('keeps a Hangul syllable one character, however the text spells it', () => {
    expect([...foldSearchText('서울')]).toEqual(['서', '울']);
    expect(foldSearchText('서울'.normalize('NFD'))).toBe('서울');
  });
});

describe('containsTerms', () => {
  it('splits on whitespace and keeps each term as written', () => {
    expect(containsTerms('  invoice   INV-2048 ')).toEqual(['invoice', 'INV-2048']);
  });

  it('drops a term that folds to one already seen', () => {
    expect(containsTerms('Café cafe CAFE meeting')).toEqual(['Café', 'meeting']);
  });
});

describe('containsSnippet', () => {
  it('marks a substring match ignoring case and accents, keeping the original text', () => {
    expect(containsSnippet('Meeting at the Café Résumé', ['cafe'], 24)).toBe('Meeting at the <mark>Café</mark> Résumé');
    expect(containsSnippet('Your INVOICE is ready', ['voic'], 24)).toBe('Your IN<mark>VOIC</mark>E is ready');
  });

  it('marks every occurrence of every term and merges overlapping ones', () => {
    expect(containsSnippet('invoice and invoice', ['invo', 'voice'], 24)).toBe(
      '<mark>invoice</mark> and <mark>invoice</mark>',
    );
  });

  it('maps matches back through a body written with combining accents', () => {
    const decomposed = 'café'.normalize('NFD');
    expect(containsSnippet(`meet at the ${decomposed}`, ['cafe'], 24)).toBe(`meet at the <mark>${decomposed}</mark>`);
  });

  it('marks a Hangul word in a body that spells its syllables as jamo', () => {
    const [word, rest] = ['서울역'.normalize('NFD'), '에서 만나요'.normalize('NFD')];
    expect(containsSnippet(`${word}${rest}`, ['서울역'], 24)).toBe(`<mark>${word}</mark>${rest}`);
  });

  it('marks a word ending in final sigma in a body written in capitals, and the other way round', () => {
    expect(containsSnippet('ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', ['δρομος'], 24)).toBe('ΚΑΛΟΣ <mark>ΔΡΟΜΟΣ</mark> σήμερα');
    expect(containsSnippet('ο δρομος', ['ΔΡΟΜΟΣ'], 24)).toBe('ο <mark>δρομος</mark>');
  });

  it('opens the window a few words before a late match and marks where it cut', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
    words[30] = 'invoice';
    const snippet = containsSnippet(words.join(' '), ['invoice'], 10);
    expect(snippet).toBe('…w22 w23 w24 w25 w26 w27 w28 w29 <mark>invoice</mark> w31…');
  });

  it('keeps the match inside a window smaller than the usual context', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    words[29] = 'invoice';
    expect(containsSnippet(words.join(' '), ['invoice'], 5)).toBe('…w25 w26 w27 w28 <mark>invoice</mark>');
  });

  it('falls back to the start of the body when no term is found in it', () => {
    expect(containsSnippet('one two three', ['zzz'], 2)).toBe('one two…');
  });

  it('returns an empty snippet for an empty body', () => {
    expect(containsSnippet('   ', ['invoice'], 24)).toBe('');
  });
});
