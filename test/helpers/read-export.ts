import { text } from 'node:stream/consumers';
import { StreamableFile } from '@nestjs/common';
import type { InfraExportDataResult } from '../../src/modules/infra/infra-data.service';

/**
 * Reads a data export to its end and parses it, as a client of the route does: from the controller's
 * answer or straight from the service's pieces.
 */
export const readExport = async (body: StreamableFile | AsyncIterable<string>): Promise<InfraExportDataResult> =>
  JSON.parse(await text(body instanceof StreamableFile ? body.getStream() : body)) as InfraExportDataResult;
