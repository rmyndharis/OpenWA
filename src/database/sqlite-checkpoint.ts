import { Worker } from 'worker_threads';

// PASSIVE never waits for a lock. A connection of the worker's own keeps the copy and its syncs off the event loop.
const CHECKPOINT_WORKER = `
const { workerData } = require('worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.file, { fileMustExist: true });
db.pragma('wal_checkpoint(PASSIVE)');
db.close();
`;

/** Copies the WAL of a SQLite file back into the file on a worker thread; nothing to do outside WAL mode. */
export function checkpointOffThread(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CHECKPOINT_WORKER, {
      eval: true,
      workerData: { file, driver: require.resolve('better-sqlite3') },
    });
    // An error ends the worker and is emitted before its exit, so a failed checkpoint has rejected by then.
    worker.once('error', reject);
    worker.once('exit', () => resolve());
  });
}
