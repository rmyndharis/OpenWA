import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deleteLocalFile,
  getLocalFile,
  iterateLocalFiles,
  openLocalFile,
  putLocalFile,
  StorageWalkRefusedError,
  type LocalWalkOptions,
} from './storage-local-files';

describe('iterateLocalFiles', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-walk-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'x');
  };

  const walk = async (prefix = '', options?: LocalWalkOptions): Promise<string[]> => {
    const files: string[] = [];
    for await (const file of iterateLocalFiles(root, prefix, options)) files.push(file);
    return files.sort();
  };

  /** A mode-000 directory is still readable by root, so the failure is injected for the one path. */
  const failReaddirAt = (suffix: string, code = 'EACCES'): Error => {
    const error = Object.assign(new Error(`${code}: cannot read ${suffix}`), { code });
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith(suffix) ? Promise.reject(error) : readdir(target, ...rest)) as never);
    return error;
  };

  const deepKey = [...Array<string>(20).fill('d'), 'deep.bin'].join('/');

  /** Walk and return what it threw. */
  const refusal = async (prefix = '', options?: LocalWalkOptions): Promise<StorageWalkRefusedError> => {
    const error = await walk(prefix, options).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StorageWalkRefusedError);
    return error as StorageWalkRefusedError;
  };

  it('lists every file with "/" separated keys', async () => {
    write('a.bin');
    write('x/y/b.bin');

    expect(await walk()).toEqual(['a.bin', 'x/y/b.bin']);
    expect(await walk('x/')).toEqual(['x/y/b.bin']);
  });

  describe('by default', () => {
    // The message reaches the API caller, so it names the path relative to the storage root and the cause, never the
    // host path. The error the host raised, with its path, stays on `cause` for the log.
    it.each(['EACCES', 'EPERM'])('refuses a directory it cannot read (%s), naming it and the cause', async code => {
      write('ok.bin');
      write('locked/hidden.bin');
      const error = failReaddirAt(path.join(root, 'locked'), code);

      const refused = await refusal();

      expect(refused.message).toBe(`Storage directory cannot be read: locked (${code})`);
      expect(refused.message).not.toContain(root);
      expect(refused.name).toBe('StorageWalkRefusedError');
      expect(refused.cause).toBe(error);
    });

    it('names the storage root as "." when the root itself cannot be read', async () => {
      failReaddirAt(root, 'EACCES');

      expect((await refusal()).message).toBe('Storage directory cannot be read: . (EACCES)');
    });

    it('lets any other failure through as it came, so it stays an internal error', async () => {
      write('broken/file.bin');
      const error = failReaddirAt(path.join(root, 'broken'), 'EIO');

      await expect(walk()).rejects.toBe(error);
    });

    // mkfs leaves a root-owned lost+found (mode 0700) at the top of a volume. A store that sits on a volume of
    // its own, read by an unprivileged user, would otherwise refuse every export and count for good.
    describe('for lost+found', () => {
      const lostAndFound = 'lost+found';

      it.each(['EACCES', 'EPERM'])('skips an unreadable %s at the storage root and says so', async code => {
        write('ok.bin');
        write(`${lostAndFound}/recovered.bin`);
        failReaddirAt(path.join(root, lostAndFound), code);
        const log = jest.fn();

        expect(await walk('', { logger: { log, warn: jest.fn() } })).toEqual(['ok.bin']);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(lostAndFound));
      });

      it('walks one it can read like any other directory', async () => {
        write(`${lostAndFound}/recovered.bin`);

        expect(await walk()).toEqual([`${lostAndFound}/recovered.bin`]);
      });

      it('still fails on one that is not at the storage root', async () => {
        write(`nested/${lostAndFound}/recovered.bin`);
        failReaddirAt(path.join(root, 'nested', lostAndFound));

        expect((await refusal()).message).toBe(`Storage directory cannot be read: nested/${lostAndFound} (EACCES)`);
      });

      it('still fails on an error that is not a permission error', async () => {
        write(`${lostAndFound}/recovered.bin`);
        const error = failReaddirAt(path.join(root, lostAndFound), 'EIO');

        await expect(walk()).rejects.toBe(error);
      });
    });

    it('refuses a directory below the maximum depth, naming it', async () => {
      write(deepKey);

      const refused = await refusal();

      expect(refused.message).toMatch(/^Storage directory exceeds the maximum traversal depth: d(\/d){19}$/);
      expect(refused.message).not.toContain(root);
    });

    // A link is neither followed (it can loop, or leave the store) nor listed, so what it points at would be
    // missing from an export or a count without a word. Refusing is the only answer that cannot lose it.
    it.each([
      ['directory', 'linked'],
      ['file', 'alias.bin'],
    ])('refuses a symbolic link to a %s, naming it', async (kind, name) => {
      write('real/inside.bin');
      write('real.bin');
      fs.symlinkSync(path.join(root, kind === 'directory' ? 'real' : 'real.bin'), path.join(root, name));

      const refused = await refusal();

      expect(refused.message).toBe(`Storage path is a symbolic link and is not followed: ${name}`);
      expect(refused.message).not.toContain(root);
    });

    it('walks a prefix that is itself a symbolic link, since the walk starts from a path', async () => {
      write('elsewhere/s1/archived.bin');
      fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'chat-media'));

      expect(await walk('chat-media/')).toEqual(['chat-media/s1/archived.bin']);
    });

    it('treats a directory removed during the walk as empty', async () => {
      write('ok.bin');
      write('gone/file.bin');
      failReaddirAt(path.join(root, 'gone'), 'ENOENT');

      expect(await walk()).toEqual(['ok.bin']);
    });
  });

  describe('when asked to skip what it cannot read', () => {
    const lenient = (): { options: LocalWalkOptions; warn: jest.Mock } => {
      const warn = jest.fn();
      return { options: { skipUnreadable: true, logger: { log: jest.fn(), warn } }, warn };
    };

    it('skips an unreadable directory, names it, and still lists the rest', async () => {
      write('ok.bin');
      write('locked/hidden.bin');
      write('other/fine.bin');
      failReaddirAt(path.join(root, 'locked'));
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin', 'other/fine.bin']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"locked"'));
      // The log keeps the host's own account of the failure, with its path; only the API message drops it.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join(root, 'locked')));
    });

    it('skips a directory below the maximum depth and still lists the rest', async () => {
      write('ok.bin');
      write(deepKey);
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maximum traversal depth'));
    });

    it('skips a symbolic link, names it, and still lists the rest', async () => {
      write('ok.bin');
      write('real/inside.bin');
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
      const { options, warn } = lenient();

      expect(await walk('', options)).toEqual(['ok.bin', 'real/inside.bin']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"linked".*symbolic link/));
    });

    it('skips without a logger too', async () => {
      write('ok.bin');
      write('locked/hidden.bin');
      failReaddirAt(path.join(root, 'locked'));

      expect(await walk('', { skipUnreadable: true })).toEqual(['ok.bin']);
    });
  });

  describe('symlink containment', () => {
    let outside: string;

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.bin'), 'top-secret');
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('rejects a prefix symlink that escapes the storage root (even with skipUnreadable)', async () => {
      fs.symlinkSync(outside, path.join(root, 'escaped'));

      await expect(walk('escaped/')).rejects.toThrow(/outside storage root/);
      await expect(walk('escaped/', { skipUnreadable: true })).rejects.toThrow(/outside storage root/);
    });

    it('returns empty for a missing prefix without throwing', async () => {
      expect(await walk('does-not-exist/')).toEqual([]);
    });
  });
});

describe('local storage file operations symlink containment', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-local-contain-'));
    root = path.join(base, 'store');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.bin'), 'outside-bytes');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('getLocalFile and openLocalFile', () => {
    it('rejects reading through a file or directory symlink that escapes the storage root', async () => {
      fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(root, 'escape-file.bin'));
      fs.symlinkSync(outside, path.join(root, 'escape-dir'));

      await expect(getLocalFile(root, 'escape-file.bin')).rejects.toThrow(/outside storage root/);
      await expect(getLocalFile(root, 'escape-dir/secret.bin')).rejects.toThrow(/outside storage root/);
      await expect(openLocalFile(root, 'escape-file.bin')).rejects.toThrow(/outside storage root/);
      await expect(openLocalFile(root, 'escape-dir/secret.bin')).rejects.toThrow(/outside storage root/);
    });

    it('preserves reading through an intra-root symlink and ENOENT on missing files', async () => {
      fs.mkdirSync(path.join(root, 'real'), { recursive: true });
      fs.writeFileSync(path.join(root, 'real', 'ok.bin'), 'inside-bytes');
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));

      expect((await getLocalFile(root, 'alias/ok.bin')).toString()).toBe('inside-bytes');
      const opened = await openLocalFile(root, 'alias/ok.bin');
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(Buffer.concat(chunks).toString()).toBe('inside-bytes');
      expect(opened.size).toBe('inside-bytes'.length);

      await expect(getLocalFile(root, 'missing.bin')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(openLocalFile(root, 'missing.bin')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('putLocalFile', () => {
    it('rejects writing through an escaping directory symlink without creating outside directories', async () => {
      fs.symlinkSync(outside, path.join(root, 'escape-dir'));

      await expect(putLocalFile(root, 'escape-dir/sub/pwn.bin', Buffer.from('bad'))).rejects.toThrow(
        /outside storage root/,
      );
      expect(fs.existsSync(path.join(outside, 'sub'))).toBe(false);
    });

    it('rejects writing to an escaping file symlink, a dangling symlink, or an intra-root file symlink', async () => {
      fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(root, 'escape-file.bin'));
      fs.symlinkSync(path.join(outside, 'created-via-dangling.bin'), path.join(root, 'dangling.bin'));
      fs.writeFileSync(path.join(root, 'inside.bin'), 'keep');
      fs.symlinkSync(path.join(root, 'inside.bin'), path.join(root, 'intra-file-link.bin'));

      await expect(putLocalFile(root, 'escape-file.bin', Buffer.from('overwrite'))).rejects.toThrow(
        /outside storage root|symbolic link/,
      );
      await expect(putLocalFile(root, 'dangling.bin', Buffer.from('create'))).rejects.toThrow(
        /outside storage root|symbolic link/,
      );
      await expect(putLocalFile(root, 'intra-file-link.bin', Buffer.from('overwrite'))).rejects.toThrow(
        /symbolic link/,
      );

      expect(fs.readFileSync(path.join(outside, 'secret.bin'), 'utf8')).toBe('outside-bytes');
      expect(fs.existsSync(path.join(outside, 'created-via-dangling.bin'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'inside.bin'), 'utf8')).toBe('keep');
    });

    it('writes regular files into nested directories and through an intra-root directory symlink', async () => {
      fs.mkdirSync(path.join(root, 'real'), { recursive: true });
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));

      await putLocalFile(root, 'nested/dir/file.bin', Buffer.from('hello'));
      await putLocalFile(root, 'alias/sub/file.bin', Buffer.from('world'));

      expect(fs.readFileSync(path.join(root, 'nested/dir/file.bin'), 'utf8')).toBe('hello');
      expect(fs.readFileSync(path.join(root, 'real/sub/file.bin'), 'utf8')).toBe('world');
    });
  });

  describe('deleteLocalFile', () => {
    it('rejects deleting through an escaping directory symlink without touching the outside file', async () => {
      fs.symlinkSync(outside, path.join(root, 'escape-dir'));

      await expect(deleteLocalFile(root, 'escape-dir/secret.bin')).rejects.toThrow(/outside storage root/);
      await expect(deleteLocalFile(root, 'escape-dir/missing-sub/file.bin')).rejects.toThrow(/outside storage root/);
      expect(fs.existsSync(path.join(outside, 'secret.bin'))).toBe(true);
    });

    it('rejects deleting through a dangling directory symlink', async () => {
      fs.symlinkSync(path.join(outside, 'nonexistent-dir'), path.join(root, 'dangling-dir'));

      await expect(deleteLocalFile(root, 'dangling-dir/file.bin')).rejects.toThrow(/symbolic link/);
    });

    it('rejects deleting an escaping file symlink or dangling escaping symlink', async () => {
      fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(root, 'escape-file.bin'));
      fs.symlinkSync(path.join(outside, 'missing.bin'), path.join(root, 'dangling-escape.bin'));

      await expect(deleteLocalFile(root, 'escape-file.bin')).rejects.toThrow(/outside storage root/);
      await expect(deleteLocalFile(root, 'dangling-escape.bin')).rejects.toThrow(/outside storage root/);
      expect(fs.lstatSync(path.join(root, 'escape-file.bin')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(root, 'dangling-escape.bin')).isSymbolicLink()).toBe(true);
    });

    it('rejects deleting an escaping directory symlink even when filePath has a trailing slash', async () => {
      fs.symlinkSync(outside, path.join(root, 'escape-dir'));
      fs.mkdirSync(path.join(root, 'real-dir'), { recursive: true });
      fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'intra-dir-link'));

      await expect(deleteLocalFile(root, 'escape-dir/')).rejects.toThrow(/outside storage root/);
      await expect(deleteLocalFile(root, 'intra-dir-link/')).rejects.toThrow(/symbolic link/);
      expect(fs.lstatSync(path.join(root, 'escape-dir')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(root, 'intra-dir-link')).isSymbolicLink()).toBe(true);
    });

    it('rejects deleting a dangling symlink whose .. segment escapes through an intermediate symlink', async () => {
      fs.symlinkSync(outside, path.join(root, 'escape-dir'));
      fs.symlinkSync('escape-dir/../missing.bin', path.join(root, 'dangling-dotdot.bin'));

      await expect(deleteLocalFile(root, 'dangling-dotdot.bin')).rejects.toThrow(/outside storage root/);
      expect(fs.lstatSync(path.join(root, 'dangling-dotdot.bin')).isSymbolicLink()).toBe(true);
    });

    it('deletes regular files and intra-root symlinks and returns cleanly on ENOENT', async () => {
      fs.writeFileSync(path.join(root, 'regular.bin'), 'x');
      fs.writeFileSync(path.join(root, 'target.bin'), 'y');
      fs.symlinkSync(path.join(root, 'target.bin'), path.join(root, 'intra-link.bin'));

      await deleteLocalFile(root, 'regular.bin');
      await deleteLocalFile(root, 'intra-link.bin');
      await expect(deleteLocalFile(root, 'never-existed/file.bin')).resolves.toBeUndefined();
      await expect(deleteLocalFile(path.join(base, 'nonexistent-root'), 'file.bin')).resolves.toBeUndefined();

      expect(fs.existsSync(path.join(root, 'regular.bin'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'intra-link.bin'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'target.bin'))).toBe(true);
    });
  });
});
