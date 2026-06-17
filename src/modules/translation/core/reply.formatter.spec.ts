// src/modules/translation/core/reply.formatter.spec.ts
import { formatCombinedReply, buildHelpText, formatStatus } from './reply.formatter';
import { GroupState } from './ports';

describe('reply.formatter', () => {
  it('formats one line per translation with an uppercased code label', () => {
    const out = formatCombinedReply([
      { lang: 'es', text: 'Hola' },
      { lang: 'fr', text: 'Bonjour' },
    ]);
    expect(out).toContain('Hola');
    expect(out).toContain('Bonjour');
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toMatch(/ES/);
  });

  it('buildHelpText lists key commands with the active prefix', () => {
    const help = buildHelpText('/tr');
    expect(help).toContain('/tr on');
    expect(help).toContain('/tr setlang');
  });

  it('formatStatus reports active state and participants', () => {
    const state: GroupState = {
      sessionId: 's',
      chatId: 'c@g.us',
      active: true,
      participants: { '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' } },
      delegatedControllers: [],
      announced: true,
    };
    const out = formatStatus(state, true);
    expect(out).toMatch(/active/i);
    expect(out).toContain('en');
  });
});
