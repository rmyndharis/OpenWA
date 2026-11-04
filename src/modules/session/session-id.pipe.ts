import { BadRequestException, Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { isSafeSessionName } from '../../common/utils/path-safety';

/** The longest session id a route takes: the cap the realtime subscribe applies to the same ids. */
export const MAX_SESSION_ID_LENGTH = 128;

/**
 * The `:sessionId` of a session route. The API issues UUIDs, but a backup restore keeps any safe key (letters, digits
 * and hyphens) as a session id and the engines run it, so the routes take those too, or the session runs with no way
 * to stop or delete it. `isSafeSessionName` has no length limit of its own; the cap keeps what the id is echoed into
 * (answers, logs, an auth directory name) bounded as the UUID check used to.
 */
@Injectable()
export class SessionIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isSafeSessionName(value) || value.length > MAX_SESSION_ID_LENGTH) {
      throw new BadRequestException(
        `Validation failed (a session id of letters, digits and hyphens, at most ${MAX_SESSION_ID_LENGTH} characters, is expected)`,
      );
    }
    return value;
  }
}

/**
 * The 404 for an id no session row has. A caller who sent a session name used to be told by the UUID check that an id
 * was expected; a name is a safe key now, so the answer says it instead (a UUID keeps the text it always had).
 */
export function sessionNotFound(id: string): NotFoundException {
  const hint = isUUID(id) ? '' : '; session routes take the session id, not its name';
  return new NotFoundException(`Session with id '${id}' not found${hint}`);
}
