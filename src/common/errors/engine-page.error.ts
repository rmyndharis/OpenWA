import { InternalServerErrorException } from '@nestjs/common';

/** The readable part of a failure WhatsApp Web threw inside the page. */
export interface PageErrorSummary {
  name: string;
  message: string;
  build?: string;
}

/** Longest name or message the response body carries; the full summary stays on `cause` for the log. */
const FIELD_LIMIT = 200;

const cut = (text: string): string => (text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}...` : text);

/**
 * Thrown by the whatsapp-web.js adapter when WhatsApp Web's own code threw inside the page while
 * carrying out an operation (a send or a status post). It keeps the documented **HTTP 500** "engine
 * error" but, unlike an unmapped Error, tells the caller what WhatsApp Web said: `code`
 * `ENGINE_PAGE_ERROR`, the thrown `name` and `message`, and, when the page could read it, the
 * running WhatsApp Web `build`, which `message` also names.
 *
 * The raw captured error, with its stack and own properties, travels as `cause` for the server log
 * and never reaches the response body.
 */
export class EnginePageError extends InternalServerErrorException {
  constructor(summary: PageErrorSummary, raw: Error) {
    const name = cut(summary.name);
    const message = cut(summary.message);
    const build = summary.build ? cut(summary.build) : undefined;
    const reason = `${message ? `${name}: ${message}` : name}${build ? ` (build ${build})` : ''}`;
    super(
      {
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'ENGINE_PAGE_ERROR',
        // The message names the build too: the message:failed hook and the bulk batch result carry
        // only this string, and the build is what tells a WhatsApp Web regression apart.
        message: `WhatsApp Web rejected the operation: ${reason}`,
        pageError: { name, message },
        ...(build ? { build } : {}),
      },
      { cause: raw },
    );
  }
}
