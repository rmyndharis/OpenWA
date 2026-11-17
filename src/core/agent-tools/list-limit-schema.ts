import { z } from 'zod';
import { DEFAULT_LIST_LIMIT } from '../../common/utils/paginate';

/**
 * `limit` of a tool that answers a bare array. The array carries no total, so this description is the only
 * place an agent learns that a full page may not be the whole list.
 */
export const listLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(DEFAULT_LIST_LIMIT)
  .optional()
  .describe(
    `Rows per call: ${DEFAULT_LIST_LIMIT} when omitted, which is also the most one call returns. ` +
      'A full page means there may be more rows; ask again with offset.',
  );
