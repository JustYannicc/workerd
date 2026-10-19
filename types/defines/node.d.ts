declare module 'cloudflare:node' {
  interface NodeStyleServer {
    listen(...args: unknown[]): this;
    address(): { port?: number | null | undefined } | null;
  }

  export function httpServerHandler(port: number): ExportedHandler;
  export function httpServerHandler(options: { port: number }): ExportedHandler;
  export function httpServerHandler(server: NodeStyleServer): ExportedHandler;

  /**
   * Dispatches a request to the `http.Server` listening on the given port and
   * resolves with its response. The direct form of `httpServerHandler()`.
   */
  export function handleAsNodeRequest(
    port: number | { port: number },
    request: Request,
    env?: unknown,
    ctx?: ExecutionContext
  ): Promise<Response>;

  /**
   * Routes inbound sockets to the `net.Server` listening on the port each
   * socket arrived on.
   */
  export function connectHandler(): ExportedHandler;

  /**
   * Dispatches an inbound socket to the `net.Server` listening on the port it
   * arrived on, resolving when the connection has closed. The direct form of
   * `connectHandler()`, for use inside a `connect()` handler, such as a
   * Durable Object's.
   */
  export function handleAsNodeConnection(
    socket: Socket,
    env?: unknown,
    ctx?: ExecutionContext
  ): Promise<void>;
}

declare module 'node:wasi' {
  /** Provider-owned inode identity, never reused during its lifetime. */
  export type Inode = bigint;

  /** Inode metadata returned by a filesystem provider. */
  export interface Stat {
    /** Filesystem object kind. */
    type: 'file' | 'directory' | 'symlink';
    /** File length in bytes. */
    size: bigint;
    /** Number of namespace links to the inode. */
    nlink: bigint;
    /** Last access time, in nanoseconds since the Unix epoch. */
    atimeNs: bigint;
    /** Last content modification time, in nanoseconds since the Unix epoch. */
    mtimeNs: bigint;
    /** Last metadata change time, in nanoseconds since the Unix epoch. */
    ctimeNs: bigint;
  }

  /** A direct child returned without following symbolic links. */
  export interface DirectoryEntry {
    /** One filename component, excluding dot entries. */
    name: string;
    /** Child inode identity. */
    inode: Inode;
    /** Filesystem object kind. */
    type: Stat['type'];
  }

  /** Atomic creation policy for one directory entry. */
  export interface CreateOptions {
    /** Filesystem object kind. */
    type: Stat['type'];
    /** Fail with EEXIST if a file already occupies the name. */
    exclusive: boolean;
    /** Symbolic-link contents; required only when creating a symbolic link. */
    target?: string;
  }

  /** Optional inode timestamps; omitted values remain unchanged. */
  export interface Times {
    /** Access time, in nanoseconds since the Unix epoch. */
    atimeNs?: bigint;
    /** Content modification time, in nanoseconds since the Unix epoch. */
    mtimeNs?: bigint;
  }

  /**
   * Inode storage shared by filesystem adapters. Methods throw symbolic POSIX
   * errors using an Error's code property; unexpected exceptions propagate.
   * File sizes and offsets are in [0, 2^63 - 1]. Negative values fail with
   * EINVAL, overflow with EFBIG. Namespace mutations and append are atomic.
   *
   * Names contain exactly one component, excluding empty, '.', '..', '/',
   * and NUL. Symlinks are followed by the caller. Buffers belong to the caller,
   * never to guest memory. A zero-byte write does not extend a file; EOF reads
   * return zero.
   */
  export interface Storage {
    /** Inode identity of the provider root directory. */
    readonly root: Inode;
    lookup(parent: Inode, name: string): Inode;
    stat(inode: Inode): Stat;
    readlink(inode: Inode): string;
    /** Lists children without '.' or '..'. */
    readdir(inode: Inode): DirectoryEntry[];
    /** Pins an inode across unlink until the matching release. */
    retain(inode: Inode): void;
    release(inode: Inode): void;
    readInto(inode: Inode, offset: bigint, target: Uint8Array): number;
    write(inode: Inode, offset: bigint, source: Uint8Array): number;
    append(
      inode: Inode,
      source: Uint8Array
    ): { offset: bigint; bytesWritten: number };
    truncate(inode: Inode, size: bigint): void;
    setTimes(inode: Inode, times: Times): void;
    /** Requests synchronization of inode data or metadata from the provider. */
    sync(inode: Inode, dataOnly: boolean): void;
    /**
     * Returns a retained inode. Nonexclusive creation may open an existing file;
     * an existing directory fails with EISDIR, a symlink with ELOOP. A target
     * is required exactly when creating a symlink. Creation never truncates.
     */
    create(parent: Inode, name: string, options: CreateOptions): Inode;
    /** Directory hard links are forbidden. */
    link(inode: Inode, parent: Inode, name: string): void;
    unlink(parent: Inode, name: string, options: { directory: boolean }): void;
    rename(
      fromParent: Inode,
      fromName: string,
      toParent: Inode,
      toName: string
    ): void;
  }

  /** Identical operations with explicit asynchronous completion. */
  export type AsyncStorage = {
    readonly [K in keyof Storage]: Storage[K] extends (
      ...args: infer A
    ) => infer R
      ? (...args: A) => Promise<R>
      : Storage[K];
  };

  /** A root capability installed at an absolute guest path. */
  export interface Mount<S = Storage> {
    /** Absolute path exposed to the guest. */
    path: string;
    /** Provider implementing the mounted inode namespace. */
    storage: S;
    /** Directory capability to mount; defaults to storage.root. */
    root?: Inode;
    /** Restricts mutations and the rights inherited by opened descriptors. */
    readOnly?: boolean;
  }

  /** Readiness returned by a standard-input/output endpoint. */
  export interface WasiPollResult {
    /** Number of bytes available for the requested direction. */
    bytes: bigint;
    /** The peer has closed its side of the stream. */
    hangup?: boolean;
  }

  /** Borrowed endpoint; closing the WASI host leaves the endpoint open. */
  export interface WasiStdio {
    /** Guarantees immediate completion or EAGAIN when flags contain NONBLOCK. */
    readonly supportsNonblocking?: boolean;
    /** Reads into a host-owned buffer using the current WASI descriptor flags. */
    readInto?: (target: Uint8Array, flags: number) => number | Promise<number>;
    /** Writes host-owned bytes using the current WASI descriptor flags. */
    write?: (source: Uint8Array, flags: number) => number | Promise<number>;
    /** Flushes pending output before synchronization completes. */
    sync?: () => void | Promise<void>;
    /** Completes when ready; abort detaches a pending readiness subscription. */
    poll?: (
      direction: 'read' | 'write',
      signal: AbortSignal
    ) => WasiPollResult | Promise<WasiPollResult>;
  }

  // WASIOptions and WASI are declared by @types/node. Merge only these two
  // Workers-specific additions; do not redeclare the existing WASI class.
  interface WASIOptions {
    /** Additional explicit roots backed by application-provided storage. */
    mounts?: Mount[];
    /** Borrowed streams; the WASI host never closes them. */
    stdio?: [WasiStdio, WasiStdio, WasiStdio];
  }

  interface WASI {
    /** Releases this host's descriptors; borrowed endpoints remain open. */
    close(): void;
  }

  /** Options for the asynchronous host, with its complete standalone shape. */
  export interface AsyncWASIOptions {
    /** WASI import namespace to expose to the guest. */
    version: 'unstable' | 'preview1';
    /** Guest argument vector. */
    args?: string[];
    /** Guest environment; entries with undefined values are omitted. */
    env?: Record<string, string | undefined>;
    /** Guest directory paths mapped to workerd node:fs virtual paths. */
    preopens?: Record<string, string>;
    /** Virtual node:fs descriptor for stdin when stdio is omitted. */
    stdin?: number;
    /** Virtual node:fs descriptor for stdout when stdio is omitted. */
    stdout?: number;
    /** Virtual node:fs descriptor for stderr when stdio is omitted. */
    stderr?: number;
    /** Return the proc_exit status from start(); defaults to true. */
    returnOnExit?: boolean;
    /** Explicit directory capabilities backed by asynchronous providers. */
    mounts?: Mount<AsyncStorage>[];
    /** Borrowed streams; the WASI host never closes them. */
    stdio?: [WasiStdio, WasiStdio, WasiStdio];
  }

  /** Explicit asynchronous lifecycle for preview1 guests with async providers. */
  export class AsyncWASI {
    constructor(options?: AsyncWASIOptions);
    readonly wasiImport: WebAssembly.ModuleImports;
    getImportObject(): WebAssembly.Imports;
    start(instance: WebAssembly.Instance): Promise<number>;
    initialize(instance: WebAssembly.Instance): Promise<void>;
    run(
      fn: (...args: Array<number | bigint>) => unknown,
      ...args: Array<number | bigint>
    ): Promise<unknown>;
    close(): Promise<void>;
  }
}
