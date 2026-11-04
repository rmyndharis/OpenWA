'use strict';

const fs = require('fs');
const path = require('path');

/**
 * How the dependency patchers replace a file.
 *
 * fs.writeFileSync opens its target and truncates it before it writes, so a write that fails part-way
 * (a full disk, an I/O error) leaves a dependency file cut off, and a later run reads the damage as an
 * unknown upstream shape and skips it. The text goes to a temporary file in the same directory instead
 * and is renamed over the target, which replaces it whole or not at all. Every failure up to and
 * including the rename leaves the target as it was, so a patcher may treat any write error as "this
 * tree was not patched" and `--best-effort` may skip it.
 *
 * A temporary file left behind by a killed run carries that run's pid and is not removed here, since it
 * could belong to a run still in progress; a later run on the same pid overwrites it.
 *
 * A patch that spans several files stages all of them before it replaces the first. If a rename then
 * fails after an earlier one succeeded, the tree is half patched; that error is marked `partial` and
 * `--best-effort` must not skip it.
 */
function writeFilesAtomic(entries) {
  const staged = [];
  try {
    for (const [file, text] of entries) {
      // The real file: a link would otherwise be replaced by a regular file.
      const target = fs.realpathSync(file);
      const temp = path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.tmp`);
      const mode = fs.statSync(target).mode & 0o7777;
      staged.push({ target, temp });
      fs.writeFileSync(temp, text, { encoding: 'utf8', mode });
      try {
        // The create applied the umask; this restores the original bits. A file system that refuses chmod
        // (a bind mount, FAT) keeps the umasked mode rather than failing a write that in place would pass.
        fs.chmodSync(temp, mode);
      } catch {
        // see above
      }
    }
    staged.forEach(({ target, temp }, replaced) => {
      try {
        fs.renameSync(temp, target);
      } catch (error) {
        error.partial = replaced > 0;
        throw error;
      }
    });
  } finally {
    // A renamed temp is gone already; a failed one must not outlive the run. Never mask the error.
    for (const { temp } of staged) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // nothing more can be done about a temp file that cannot be removed
      }
    }
  }
}

function writeFileAtomic(file, text) {
  writeFilesAtomic([[file, text]]);
}

module.exports = { writeFileAtomic, writeFilesAtomic };
