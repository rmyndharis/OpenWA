import { renderTemplate } from './template-render';

describe('renderTemplate', () => {
  describe('canonical double-brace {{name}}', () => {
    it('substitutes a known placeholder', () => {
      expect(renderTemplate('Hi {{name}}', { name: 'Sam' })).toBe('Hi Sam');
    });

    it('tolerates surrounding whitespace', () => {
      expect(renderTemplate('Hi {{ name }}', { name: 'Sam' })).toBe('Hi Sam');
    });

    it('supports dotted/dashed keys', () => {
      expect(renderTemplate('{{first.name}}-{{order-id}}', { 'first.name': 'A', 'order-id': '7' })).toBe('A-7');
    });

    it('leaves an unknown placeholder literal', () => {
      expect(renderTemplate('Hi {{name}}', {})).toBe('Hi {{name}}');
    });
  });

  describe('legacy single-brace {name} (deprecated, still supported)', () => {
    it('substitutes a known placeholder', () => {
      expect(renderTemplate('Hi {name}', { name: 'Sam' })).toBe('Hi Sam');
    });

    it('leaves an unknown placeholder literal', () => {
      expect(renderTemplate('Hi {name}', {})).toBe('Hi {name}');
    });
  });

  describe('mixed + disambiguation', () => {
    it('substitutes both conventions in one string', () => {
      expect(renderTemplate('{greeting}, {{name}}!', { greeting: 'Hello', name: 'Sam' })).toBe('Hello, Sam!');
    });

    it('does NOT mangle {{name}} into {value} (double-brace consumed as a unit)', () => {
      expect(renderTemplate('{{name}}', { name: 'X' })).toBe('X');
    });
  });

  describe('edge cases', () => {
    it('returns an empty body unchanged', () => {
      expect(renderTemplate('', { name: 'Sam' })).toBe('');
    });

    it('leaves non-placeholder braces untouched', () => {
      expect(renderTemplate('a { b } c', { b: 'X' })).toBe('a { b } c'); // spaces => not a legacy placeholder
    });

    it('substitutes an explicitly-provided empty-string value', () => {
      // hasOwnProperty semantics: an explicit '' substitutes to '' (the legacy `||` renderer left it literal).
      expect(renderTemplate('[{name}]', { name: '' })).toBe('[]');
    });
  });
});
