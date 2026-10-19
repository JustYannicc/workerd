// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AsyncWASI, WASI } from 'node:wasi';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import {
  createAsyncStorage,
  createMemoryStorage,
} from './wasi-test-storage.js';
import { createReactor, createStdio } from './wasi-preview1-test-support.js';

const FD_READ = 2n;
const FD_WRITE = 64n;
const ALL_RIGHTS = (1n << 28n) - 1n;
const MUTATING_RIGHTS =
  1n |
  FD_WRITE |
  (1n << 8n) |
  (1n << 9n) |
  (1n << 10n) |
  (1n << 12n) |
  (1n << 16n) |
  (1n << 17n) |
  (1n << 19n) |
  (1n << 20n) |
  (1n << 22n) |
  (1n << 23n) |
  (1n << 24n) |
  (1n << 25n) |
  (1n << 26n);
const READ_ONLY_RIGHTS = ALL_RIGHTS & ~MUTATING_RIGHTS;
const seed = Uint8Array.of(0x00, 0xff, 0x41);

export async function testReadOnlyOpen() {
  for (const Host of [WASI, AsyncWASI]) {
    const store = createMemoryStorage({ 'note.bin': seed });
    const asyncMode = Host === AsyncWASI;
    const storage = asyncMode
      ? createAsyncStorage(store.storage)
      : store.storage;
    const { host, instance } = createReactor(
      storage,
      createStdio().stdio,
      Host,
      {
        mounts: [{ path: '/data', storage, readOnly: true }],
      }
    );
    const { memory } = instance.exports;
    const call = (name, ...args) =>
      asyncMode
        ? host.run(instance.exports[name], ...args)
        : instance.exports[name](...args);
    const open = async (path, oflags, base, inheriting = 0n) => {
      const bytes = new TextEncoder().encode(path);
      new Uint8Array(memory.buffer, 4096, bytes.byteLength).set(bytes);
      return call(
        'openPathRights',
        4096,
        bytes.byteLength,
        oflags,
        base,
        inheriting
      );
    };
    try {
      await host.initialize(instance);
      strictEqual(await open('note.bin', 0, ALL_RIGHTS), 0);
      const view = new DataView(memory.buffer);
      const fileFd = view.getUint32(16, true);
      strictEqual(await call('fdStat', fileFd, 64), 0);
      strictEqual(view.getBigUint64(72, true) & FD_WRITE, 0n);
      view.setUint32(96, 256, true);
      view.setUint32(100, 16, true);
      strictEqual(await call('readFd', fileFd, 96, 1, 112), 0);
      strictEqual(view.getUint32(112, true), seed.byteLength);
      deepStrictEqual(
        new Uint8Array(memory.buffer, 256, seed.byteLength),
        seed
      );
      strictEqual(await call('writeFd', fileFd, 96, 1, 112), 76);
      deepStrictEqual(store.readFile('note.bin'), seed);

      strictEqual(await open('.', 2, READ_ONLY_RIGHTS, ALL_RIGHTS), 0);
      const directoryFd = view.getUint32(16, true);
      strictEqual(
        await call('readDirectory', directoryFd, 8192, 1024, 0n, 112),
        0
      );
      strictEqual(view.getUint32(112, true) > 0, true);
      strictEqual(await open('new.bin', 1, ALL_RIGHTS), 76);
      throws(() => store.inodeFor('new.bin'), { code: 'ENOENT' });
      strictEqual(await open('note.bin', 8, ALL_RIGHTS), 76);
      deepStrictEqual(store.readFile('note.bin'), seed);
      strictEqual(await open('note.bin', 0, 1n << 63n), 76);

      strictEqual(await call('fdStat', 3, 64), 0);
      const base = view.getBigUint64(72, true);
      const inheriting = view.getBigUint64(80, true);
      strictEqual(await call('setFdRights', 3, base, inheriting & ~FD_READ), 0);
      strictEqual(await open('note.bin', 0, FD_READ), 76);
      strictEqual(await open('note.bin', 0, ALL_RIGHTS), 76);
    } finally {
      await host.close();
    }
    strictEqual(store.retainCount(store.storage.root), 0);
    strictEqual(store.retainCount(store.inodeFor('note.bin')), 0);
  }
}
