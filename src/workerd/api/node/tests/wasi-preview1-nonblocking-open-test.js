// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WASI, AsyncWASI } from 'node:wasi';
import { deepStrictEqual, strictEqual } from 'node:assert';
import {
  createAsyncStorage,
  createMemoryStorage,
} from './wasi-test-storage.js';
import { createReactor, createStdio } from './wasi-preview1-test-support.js';

const NONBLOCK = 4;
const FD_READ = 2n;
const FD_FDSTAT_SET_FLAGS = 8n;
const seed = Uint8Array.of(0x00, 0xff, 0x41);

export async function testNonblockingPathOpen() {
  for (const Host of [WASI, AsyncWASI]) {
    const store = createMemoryStorage({ 'note.bin': seed });
    const directory = store.storage.create(store.storage.root, 'directory', {
      type: 'directory',
      exclusive: true,
    });
    store.storage.release(directory);
    const asyncMode = Host === AsyncWASI;
    const storage = asyncMode
      ? createAsyncStorage(store.storage)
      : store.storage;
    const { host, instance } = createReactor(
      storage,
      createStdio().stdio,
      Host
    );
    const { memory } = instance.exports;
    const call = (name, ...args) =>
      asyncMode
        ? host.run(instance.exports[name], ...args)
        : instance.exports[name](...args);
    const open = async (path, oflags, rights, flags) => {
      const bytes = new TextEncoder().encode(path);
      new Uint8Array(memory.buffer, 4096, bytes.byteLength).set(bytes);
      return call('openPath', 4096, bytes.byteLength, oflags, rights, flags);
    };
    const fdStat = async (fd, type, flags) => {
      strictEqual(await call('fdStat', fd, 64), 0);
      const view = new DataView(memory.buffer);
      strictEqual(view.getUint8(64), type);
      strictEqual(view.getUint16(66, true), flags);
    };
    try {
      await host.initialize(instance);
      strictEqual(await open('note.bin', 0, FD_READ, NONBLOCK), 0);
      const fileFd = new DataView(memory.buffer).getUint32(16, true);
      await fdStat(fileFd, 4, NONBLOCK);
      const view = new DataView(memory.buffer);
      view.setUint32(96, 256, true);
      view.setUint32(100, 16, true);
      strictEqual(await call('readFd', fileFd, 96, 1, 80), 0);
      strictEqual(
        new DataView(memory.buffer).getUint32(80, true),
        seed.byteLength
      );
      deepStrictEqual(
        new Uint8Array(memory.buffer, 256, seed.byteLength),
        seed
      );

      strictEqual(await open('directory', 2, 0n, NONBLOCK), 0);
      const directoryFd = new DataView(memory.buffer).getUint32(16, true);
      await fdStat(directoryFd, 3, NONBLOCK);

      strictEqual(
        await open('note.bin', 0, FD_READ | FD_FDSTAT_SET_FLAGS, 0),
        0
      );
      const ordinaryFd = new DataView(memory.buffer).getUint32(16, true);
      strictEqual(await call('setFdFlags', ordinaryFd, NONBLOCK), 58);
      await fdStat(ordinaryFd, 4, 0);

      strictEqual(await open('note.bin', 0, FD_READ, 32), 28);
      strictEqual(await open('directory', 16, 0n, NONBLOCK), 28);
      strictEqual(await open('note.bin', 2, FD_READ, NONBLOCK), 54);
      strictEqual(await open('absent', 0, FD_READ, NONBLOCK), 44);
    } finally {
      await host.close();
    }
    strictEqual(store.retainCount(store.storage.root), 0);
    strictEqual(store.retainCount(store.inodeFor('note.bin')), 0);
    strictEqual(store.retainCount(directory), 0);
  }
}
