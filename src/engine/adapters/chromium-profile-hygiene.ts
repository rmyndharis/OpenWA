import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { LoggerService } from '../../common/services/logger.service';

/**
 * Chromium/profile hygiene run before a whatsapp-web.js browser launches.
 *
 * Neither of these is about WhatsApp. They clean up after the OPERATING SYSTEM and the container: a
 * process killed with SIGKILL leaves an orphaned browser and stale profile locks behind, and both
 * must be dealt with before the next launch. That is an independent audience — it changes when
 * Docker, Puppeteer or the host platform changes, never when the WhatsApp protocol does — so it lives
 * outside the adapter that implements the protocol.
 *
 * Both are best-effort by contract: they log at debug and never throw, so a hostile `ps` or an
 * unreadable profile dir can never block an engine start.
 */

/** Just enough of the logger to report; the adapter passes its own so spies keep observing it. */
type HygieneLogger = Pick<LoggerService, 'debug' | 'log'>;

/**
 * SIGKILL any Chromium orphaned by a previous lifetime of this process. When OpenWA dies hard
 * (kill -9, crash, host reboot) Puppeteer's exit hook never runs, so the browser survives as an
 * orphan — leaking memory and pinning the session profile dir. Orphans are identified by the
 * `--openwa-session=<id>` marker arg appended to the puppeteer args at launch (Chromium ignores
 * the unknown flag; it is purely a `ps` label). Best-effort: never throws — a `ps` failure only
 * logs at debug, so the sweep can never block an engine start.
 */
export async function killOrphanedChromiumProcesses(sessionId: string, logger: HygieneLogger): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    logger.debug(`Skipping orphaned Chromium sweep: unsupported platform ${process.platform}`);
    return;
  }
  try {
    // No shell: the args array is handed to ps verbatim, so nothing here is injectable.
    // maxBuffer is raised because `ps -eo args` prints full command lines, which on a busy host
    // (many Chromium renderers carrying dozens of flags each) can exceed the 1MB default.
    const psOutput = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        // The @types/node ExecFileException is an Omit<> of ErrnoException, which the type
        // checker no longer recognises as an Error — narrow it explicitly for the reject.
        if (error) reject(error instanceof Error ? error : new Error(error.message));
        else resolve(stdout);
      });
    });
    // Token-exact marker match: the marker is a single argv token, so it must appear delimited by
    // whitespace or string boundaries. A plain substring test would let restarting session
    // `sales` SIGKILL the LIVE browser of sibling `sales2` (their markers share a prefix).
    const marker = `--openwa-session=${sessionId}`;
    const markerRe = new RegExp('(?:^|\\s)' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)');
    const killedPids: number[] = [];
    for (const line of psOutput.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const args = match[2];
      if (pid === process.pid || !markerRe.test(args)) continue;
      // Never kill a non-browser process that happens to carry the marker string
      // (e.g. a `grep --openwa-session=…` probing the process table).
      if (!/chrome|chromium|headless/i.test(args)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch (error) {
        // ESRCH: the process exited between `ps` and the kill — nothing left to do.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          logger.debug(`Could not SIGKILL orphaned Chromium pid ${pid}`, { error: String(error) });
        }
      }
    }
    if (killedPids.length > 0) {
      logger.log(
        `Killed ${killedPids.length} orphaned Chromium process(es) left over from a previous process lifetime`,
        { sessionId, pids: killedPids },
      );
    }
  } catch (error) {
    logger.debug('Could not enumerate processes for the orphaned Chromium sweep', { error: String(error) });
  }
}

/**
 * Remove Chromium's SingletonLock/SingletonSocket/SingletonCookie from the LocalAuth profile dir
 * (same dir clearLocalAuth removes) before the browser launches. A hard-killed Chromium
 * (SIGKILL/crash) leaves them behind, and on some setups (e.g. Docker PID reuse) the stale files
 * block the next launch unless they are cleared first. Best-effort: a removal
 * failure only logs at debug and never fails the start.
 */
export async function removeStaleSingletonFiles(
  sessionId: string,
  sessionDataPath: string,
  logger: HygieneLogger,
): Promise<void> {
  const profileDir = path.join(path.resolve(sessionDataPath), `session-${sessionId}`);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await fs.promises.rm(path.join(profileDir, name), { force: true });
    } catch (error) {
      logger.debug(`Could not remove stale ${name} from ${profileDir}`, { error: String(error) });
    }
  }
}
