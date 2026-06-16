declare module 'archiver' {
  import { PassThrough } from 'stream';
  import { ZlibOptions } from 'zlib';

  interface ArchiverOptions {
    gzip?: boolean;
    gzipOptions?: ZlibOptions;
    statConcurrency?: number;
    forceUTC?: boolean;
    highWaterMark?: number;
  }

  class Archiver extends PassThrough {
    constructor(options?: ArchiverOptions);
    append(source: any, data: any): this;
    file(file: string, data: any): this;
    directory(dirpath: string, destpath: string | false, data?: any): this;
    symlink(filepath: string, target: string): this;
    finalize(): Promise<void>;
  }

  class TarArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  class JsonArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  function archiver(format: string, options?: ArchiverOptions): Archiver;

  export { Archiver, TarArchive, ZipArchive, JsonArchive };
  export default archiver;
}
