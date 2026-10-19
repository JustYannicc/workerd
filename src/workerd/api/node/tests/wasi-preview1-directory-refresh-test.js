// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AsyncWASI, WASI } from 'node:wasi';
import { deepStrictEqual, strictEqual } from 'node:assert';
import {
  createAsyncStorage,
  createMemoryStorage,
} from './wasi-test-storage.js';
import { createReactor, createStdio } from './wasi-preview1-test-support.js';

export async function testDirectoryRefresh() {
  for (const Host of [WASI, AsyncWASI]) {
    const store = createMemoryStorage({ 'a.bin': new Uint8Array() });
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
    const names = async (cookie) => {
      strictEqual(await call('readDirectory', 3, 4096, 1024, cookie, 64), 0);
      const view = new DataView(memory.buffer);
      const used = view.getUint32(64, true);
      const result = [];
      for (let offset = 0; offset < used;) {
        const length = view.getUint32(4096 + offset + 16, true);
        result.push(
          new TextDecoder().decode(
            new Uint8Array(memory.buffer, 4096 + offset + 24, length)
          )
        );
        offset += 24 + length;
      }
      return result;
    };
    const create = (name) => {
      const inode = store.storage.create(store.storage.root, name, {
        type: 'file',
        exclusive: true,
      });
      store.storage.release(inode);
    };
    try {
      await host.initialize(instance);
      deepStrictEqual(await names(0n), ['.', '..', 'a.bin']);
      create('b.bin');
      deepStrictEqual(await names(2n), ['a.bin']);
      deepStrictEqual(await names(0n), ['.', '..', 'a.bin', 'b.bin']);
      create('c.bin');
      strictEqual(await call('seekFd', 3, 0n, 0, 80), 0);
      deepStrictEqual(await names(2n), ['a.bin', 'b.bin', 'c.bin']);
    } finally {
      await host.close();
    }
    strictEqual(store.retainCount(store.storage.root), 0);
  }
}
