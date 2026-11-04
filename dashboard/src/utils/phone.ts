// Reading a phone number typed or pasted into the dashboard. The gateway takes ASCII digits only, while an operator
// may type or paste the number in the digits of their own script or from a CJK input method.

// Unicode keeps every script's decimal digits in an unbroken run that starts at its zero.
function asciiDigit(digit: string): string {
  const code = digit.codePointAt(0)!;
  let zero = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
  return String((code - zero) % 10);
}

// The text as typed or pasted: the full-width forms of ASCII characters (a plus or a digit from a CJK input method)
// folded to ASCII, invisible format marks such as the direction marks of a right-to-left chat dropped, and every
// script's decimal digits as ASCII ones. Only that block is folded: a general compatibility fold would also turn
// circled and superscript numbers and fractions, which are list bullets and footnote marks, into digits.
export function normalizePhoneText(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\p{Cf}/gu, '')
    .replace(/(?![0-9])\p{Nd}/gu, asciiDigit);
}

// The digits of a search query that reads as a phone number: digits, with the spaces, plus sign, parentheses, hyphens
// and dots a number is written with. Any other query gives none, so it matches names only: "Shop 2" names something,
// and its 2 is no reason to list every number that holds one.
export function phoneQueryDigits(query: string): string {
  const text = normalizePhoneText(query).trim();
  return /^[\d\s+().-]+$/.test(text) ? text.replace(/\D/g, '') : '';
}
