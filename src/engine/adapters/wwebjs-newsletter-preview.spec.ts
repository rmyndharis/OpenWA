import * as fs from 'fs';
import * as path from 'path';

describe('whatsapp-web.js newsletter link-preview backport', () => {
  it('passes the destination chat to link-preview generation', () => {
    const dependencyRoot = path.dirname(require.resolve('whatsapp-web.js/package.json'));
    const source = fs.readFileSync(path.join(dependencyRoot, 'src', 'util', 'Injected', 'Utils.js'), 'utf8');

    expect(source).toContain('.getLinkPreview(link, chat);');
  });
});
