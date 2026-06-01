import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Raised when a request reaches a node that does not hold the session's live
 * engine, but the ownership registry shows another node does (Tier 4). 409
 * Conflict with the owner id lets a smart client or proxy retry against the
 * right node instead of seeing a misleading "session not started".
 */
export class SessionOwnedElsewhereException extends HttpException {
  constructor(
    public readonly sessionId: string,
    public readonly owner: string,
  ) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Session Owned Elsewhere',
        message: `Session '${sessionId}' is active on another instance ('${owner}'). Route the request to that node.`,
        sessionId,
        owner,
      },
      HttpStatus.CONFLICT,
    );
  }
}
