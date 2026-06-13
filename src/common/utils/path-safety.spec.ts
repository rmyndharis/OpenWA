import * as path from 'path';
import { isPathWithin } from './path-safety';

describe('isPathWithin', () => {
  const root = path.resolve('/srv/app/data');

  it('allows a normal nested path', () => {
    expect(isPathWithin(root, 'media/file.jpg')).toBe(true);
  });

  it('allows the root itself', () => {
    expect(isPathWithin(root, '.')).toBe(true);
  });

  it('blocks parent traversal via ".."', () => {
    expect(isPathWithin(root, '../../etc/passwd')).toBe(false);
  });

  it('blocks an absolute path outside the root', () => {
    expect(isPathWithin(root, '/etc/passwd')).toBe(false);
  });

  it('blocks a sibling directory that shares the root prefix', () => {
    // "/srv/app/data-evil" must NOT be considered inside "/srv/app/data"
    expect(isPathWithin('/srv/app/data', '/srv/app/data-evil/x')).toBe(false);
  });
});
