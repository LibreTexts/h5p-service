/**
 * The part of yazl 3 this service uses. yazl ships no types, and the
 * DefinitelyTyped package lags its 3.x API, `addReadStreamLazy` included.
 */
declare module "yazl" {
  import type { EventEmitter } from "node:events";
  import type { Readable } from "node:stream";

  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable;
    addReadStream(readStream: Readable, metadataPath: string): void;
    addReadStreamLazy(
      metadataPath: string,
      getReadStreamFunction: (cb: (err: Error | null, readStream?: Readable) => void) => void
    ): void;
    end(): void;
  }

  const yazl: { ZipFile: typeof ZipFile };
  export default yazl;
}
