import { constants as bufferConstants, isAscii, isUtf8 } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parseBodyLimitBytes } from '../../config/inflight-body-budget';

/**
 * Heap a restore needs per byte of a body whose characters all fit Latin-1, ASCII included, which V8
 * keeps at one byte a character. The body parser decodes the body to one string and parses it whole
 * before the route runs: measured on a text history in ASCII, the string and the parsed tables
 * together take 2.18 bytes of heap per byte of body, and accented Latin-1 text takes no more. On a
 * 1 GiB heap a body of 429 MB was still restored, with about 30 MB of heap to spare, and one of
 * 483 MB ended the process.
 */
const RESTORE_HEAP_PER_ONE_BYTE_TEXT_BYTE = 2.5;

/**
 * The same for a body with any other character in it: one emoji anywhere makes the decoded string
 * two bytes a character throughout. Measured on a 1 GiB heap with an emoji in every message, a
 * 281 MB body was restored and one of 324 MB ended the process: 3.2 to 3.7 bytes of free heap a byte.
 */
const RESTORE_HEAP_PER_OTHER_BYTE = 4;

/** A body of this size has always been accepted, and costs too little to weigh against the heap. */
const ALWAYS_ACCEPTED_BYTES = parseBodyLimitBytes('25mb');

const RESTORE_ADVICE =
  'Raise the memory of the process, or restore a copy made by scripts/backup.sh with scripts/restore.sh instead.';

const isImport = (req: Request): boolean =>
  req.method === 'POST' && req.path.replace(/\/+$/, '').toLowerCase() === '/api/infra/import-data';

/** The longest body the free heap can restore at this cost a byte, and never one longer than a string. */
function restorableBytes(heapPerByte: number): number {
  const heap = getHeapStatistics();
  return Math.max(
    ALWAYS_ACCEPTED_BYTES,
    Math.min(bufferConstants.MAX_STRING_LENGTH, Math.floor((heap.heap_size_limit - heap.used_heap_size) / heapPerByte)),
  );
}

/**
 * Whether the body decodes to a string V8 keeps at one byte a character: UTF-8 with nothing above
 * U+00FF, whose lead bytes are all below 0xc4. A byte that is not UTF-8 decodes to U+FFFD.
 */
function decodesToOneByteText(body: Buffer): boolean {
  if (isAscii(body)) return true;
  if (!isUtf8(body)) return false;
  for (let i = 0; i < body.length; i++) if (body[i] >= 0xc4) return false;
  return true;
}

/**
 * Refuse, before a byte of it is read, a body for POST /api/infra/import-data that this process
 * cannot restore even if all of it fits Latin-1: one whose text would be longer than a string can be, or
 * whose parse would not fit the heap that is free. Only a backup above the default body cap gets
 * here at all, with BODY_SIZE_LIMIT raised for it as the migration guide says, and running out of
 * heap while parsing it takes the gateway down with every session on it. A body that declares no
 * length is taken to be as long as the body cap lets it be.
 *
 * Installed ahead of the body parser, which is where the memory goes, and so ahead of the guards.
 * Only a caller the route would let restore (`mayRestore`: an admin key no session or chat
 * restriction limits) is weighed against the heap and told the figures: the route restores nothing
 * for anyone else, so a body above the default cap is refused at that size, and where the refusal
 * starts says nothing about the memory that is free.
 */
export function refuseUnrestorableImport(
  bodyLimitBytes: number,
  mayRestore: (req: Request) => boolean | Promise<boolean>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isImport(req)) return next();
    const declared = Number(req.headers['content-length'] ?? Number.NaN);
    const bytes = Number.isFinite(declared) ? declared : bodyLimitBytes;
    if (bytes <= ALWAYS_ACCEPTED_BYTES) return next();
    const judge = (allowed: boolean): void => {
      let message =
        `A backup above ${ALWAYS_ACCEPTED_BYTES} bytes is read only from a caller with an admin API key ` +
        'that no session or chat restriction limits.';
      if (allowed) {
        const limit = restorableBytes(RESTORE_HEAP_PER_ONE_BYTE_TEXT_BYTE);
        if (bytes <= limit) return next();
        // Reading an undeclared body to learn its size is the unbounded parse this guard exists to refuse.
        message = Number.isFinite(declared)
          ? `The backup is ${bytes} bytes, and with the memory this process has free it can restore at most ` +
            `${limit}. ${RESTORE_ADVICE}`
          : 'The backup was sent without a Content-Length, so its size cannot be checked against the memory ' +
            'this process has free before it is read. Send it with its length: curl --data-binary @file does.';
      }
      res
        .status(413)
        .set('Connection', 'close')
        .json({ statusCode: 413, error: 'Payload Too Large', message, code: 'IMPORT_TOO_LARGE' });
    };
    const allowed = mayRestore(req);
    if (typeof allowed === 'boolean') judge(allowed);
    else void allowed.then(judge, next);
  };
}

/**
 * The second look, at the body of POST /api/infra/import-data as read and before it is decoded: one
 * with a character outside Latin-1 is weighed at RESTORE_HEAP_PER_OTHER_BYTE, which its declared
 * length could not tell. The heap is measured again either way, so a restore read while an earlier one was still
 * arriving is weighed against what that one holds once parsed: body-parser verifies, decodes and
 * parses in one turn. Called from the body parsers' `verify`, which throws the refusal for the parser
 * to answer with its status. A body above the default cap gets this far only from a caller the first
 * check let restore, so the message names the figures.
 */
export function refuseUnrestorableImportBody(req: Request, body: Buffer): void {
  if (body.length <= ALWAYS_ACCEPTED_BYTES || !isImport(req)) return;
  const oneByte = decodesToOneByteText(body);
  const limit = restorableBytes(oneByte ? RESTORE_HEAP_PER_ONE_BYTE_TEXT_BYTE : RESTORE_HEAP_PER_OTHER_BYTE);
  if (body.length <= limit) return;
  const message = oneByte
    ? `The backup is ${body.length} bytes, and with the memory this process has free it can restore at most ` +
      `${limit}. ${RESTORE_ADVICE}`
    : `The backup is ${body.length} bytes and holds characters outside Latin-1, so a restore keeps its text at ` +
      `two bytes a character: with the memory this process has free it can restore at most ${limit} bytes of ` +
      `such a backup. ${RESTORE_ADVICE}`;
  throw new HttpException(
    { statusCode: HttpStatus.PAYLOAD_TOO_LARGE, error: 'Payload Too Large', message, code: 'IMPORT_TOO_LARGE' },
    HttpStatus.PAYLOAD_TOO_LARGE,
  );
}
