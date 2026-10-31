import { containsScore } from './search-score';

describe('containsScore', () => {
  it('scores a whole word above a word start above a match inside a word', () => {
    expect(containsScore('Please pay the invoice today', ['invoice'])).toBe(3);
    expect(containsScore('Invoiced orders are listed below', ['invoice'])).toBe(2);
    expect(containsScore('Reinvoice requested', ['invoice'])).toBe(1);
  });

  it('keeps the best occurrence of a term', () => {
    expect(containsScore('reinvoice, then invoice', ['invoice'])).toBe(3);
  });

  it('ignores case and accents, and treats punctuation as a word boundary', () => {
    expect(containsScore('Meeting at the CAFÉ.', ['cafe'])).toBe(3);
    expect(containsScore('INV-2048 is ready', ['2048'])).toBe(3);
  });

  it('adds the scores of all terms', () => {
    expect(containsScore('Your invoice INV-2048 is ready', ['invoice', '2048'])).toBe(6);
    expect(containsScore('Thanks, I will pay the invoice today', ['invoice', 'to'])).toBe(5);
  });

  it('reads final sigma as sigma, whichever side writes it', () => {
    expect(containsScore('ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', ['δρομος'])).toBe(3);
    expect(containsScore('ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', ['δρομοσ'])).toBe(3);
  });

  it('scores 0 for a term the body does not contain', () => {
    expect(containsScore('Order shipped', ['invoice'])).toBe(0);
  });
});
