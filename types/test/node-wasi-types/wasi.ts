// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  AsyncWASI,
  WASI,
  type AsyncStorage,
  type AsyncWASIOptions,
  type CreateOptions,
  type DirectoryEntry,
  type Inode,
  type Mount,
  type Stat,
  type Storage,
  type Times,
  type WasiPollResult,
  type WasiStdio,
  type WASIOptions,
} from 'node:wasi';
import { expectTypeOf } from 'expect-type';

// wasi.d.ts is loaded directly so this isolated test avoids unrelated Node
// globals. The real Node declaration uses this dictionary shape.
declare global {
  namespace NodeJS {
    interface Dict<T> {
      [key: string]: T | undefined;
    }
  }
}

const root: Inode = 1n;
const file: Inode = 2n;
const directoryStat: Stat = {
  type: 'directory',
  size: 0n,
  nlink: 1n,
  atimeNs: 0n,
  mtimeNs: 0n,
  ctimeNs: 0n,
};
const fileEntry: DirectoryEntry = { name: 'note.txt', inode: file, type: 'file' };
const times: Times = { atimeNs: 1n, mtimeNs: 2n };
const createOptions: CreateOptions = {
  type: 'symlink',
  exclusive: true,
  target: 'note.txt',
};
void [directoryStat, fileEntry, times, createOptions];

const storage: Storage = {
  root,
  lookup: () => file,
  stat: () => directoryStat,
  readlink: () => 'note.txt',
  readdir: () => [fileEntry],
  retain: () => {},
  release: () => {},
  readInto: (_inode, _offset, target) => target.byteLength,
  write: (_inode, _offset, source) => source.byteLength,
  append: (_inode, source) => ({ offset: 0n, bytesWritten: source.byteLength }),
  truncate: () => {},
  setTimes: () => {},
  sync: () => {},
  create: () => file,
  link: () => {},
  unlink: () => {},
  rename: () => {},
};

const asyncStorage: AsyncStorage = {
  root,
  lookup: async () => file,
  stat: async () => directoryStat,
  readlink: async () => 'note.txt',
  readdir: async () => [fileEntry],
  retain: async () => {},
  release: async () => {},
  readInto: async (_inode, _offset, target) => target.byteLength,
  write: async (_inode, _offset, source) => source.byteLength,
  append: async (_inode, source) => ({
    offset: 0n,
    bytesWritten: source.byteLength,
  }),
  truncate: async () => {},
  setTimes: async () => {},
  sync: async () => {},
  create: async () => file,
  link: async () => {},
  unlink: async () => {},
  rename: async () => {},
};

const stdio: [WasiStdio, WasiStdio, WasiStdio] = [
  { readInto: (target) => target.byteLength },
  { write: (source) => source.byteLength },
  { sync: () => {} },
];

// Node's existing fields and WASI class combine with the two Workers-specific
// option members. This uses the class from @types/node, not a duplicate.
const syncOptions: WASIOptions = {
  version: 'preview1',
  args: ['guest', '--mode=test'],
  env: { MODE: 'test' },
  preopens: { '/data': '/virtual/data' },
  stdin: 0,
  stdout: 1,
  stderr: 2,
  returnOnExit: true,
  mounts: [{ path: '/scratch', storage }],
  stdio,
};
const syncHost = new WASI(syncOptions);
expectTypeOf(syncHost.start).toEqualTypeOf<(instance: object) => number>();
expectTypeOf(syncHost.initialize).toEqualTypeOf<
  (instance: object) => void
>();
expectTypeOf(syncHost.close).toEqualTypeOf<() => void>();

// AsyncWASIOptions independently includes every standard constructor field
// and accepts Promise-returning operations for mounted storage.
const asyncOptions: AsyncWASIOptions = {
  version: 'preview1',
  args: ['guest', '--mode=async'],
  env: { MODE: 'async' },
  preopens: { '/legacy': '/virtual/legacy' },
  stdin: 0,
  stdout: 1,
  stderr: 2,
  returnOnExit: false,
  mounts: [{ path: '/data', storage: asyncStorage }],
  stdio: [
    { readInto: async (target) => target.byteLength },
    {
      write: async (source) => source.byteLength,
      poll: async (_direction, _signal): Promise<WasiPollResult> => ({
        bytes: 1n,
        hangup: false,
      }),
    },
    {},
  ],
};
const asyncHost = new AsyncWASI(asyncOptions);
expectTypeOf(asyncHost.start).toEqualTypeOf<
  (instance: WebAssembly.Instance) => Promise<number>
>();
expectTypeOf(asyncHost.initialize).toEqualTypeOf<
  (instance: WebAssembly.Instance) => Promise<void>
>();
expectTypeOf(asyncHost.close).toEqualTypeOf<() => Promise<void>>();
expectTypeOf(asyncHost.run).toEqualTypeOf<
  (
    fn: (...args: Array<number | bigint>) => unknown,
    ...args: Array<number | bigint>
  ) => Promise<unknown>
>();

function acceptsSyncMount(_mount: Mount<Storage>): void {}
function acceptsAsyncMount(_mount: Mount<AsyncStorage>): void {}

// @ts-expect-error AsyncWASI requires Promise-returning provider operations.
acceptsAsyncMount({ path: '/data', storage });
// @ts-expect-error WASI requires synchronous provider operations.
acceptsSyncMount({ path: '/data', storage: asyncStorage });
