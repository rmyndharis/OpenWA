/// <reference types="node" />
// A stylesheet read into its style rules, for tests that guard a layout. Each rule carries the @media
// condition it sits under ('' at the top level), so a test can ask what a selector declares at one width
// and not at another. At-rules other than @media (keyframes, font-face) are left out.
import { readFileSync } from 'node:fs';

export interface Rule {
  media: string;
  selectors: string[];
  body: string;
}

export function readRules(sheet: URL): Rule[] {
  return parse(readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
}

function parse(text: string, media = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const header = text.slice(i, open).trim();
    let depth = 1;
    let k = open + 1;
    while (k < text.length && depth) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      k++;
    }
    const body = text.slice(open + 1, k - 1);
    if (header.startsWith('@media')) out.push(...parse(body, header));
    else if (!header.startsWith('@')) out.push({ media, selectors: header.split(',').map(s => s.trim()), body });
    i = k;
  }
  return out;
}

/** What a rule body gives `prop`, or undefined when it does not set it. */
export function decl(body: string, prop: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
}
