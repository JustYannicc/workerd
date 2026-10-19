// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import * as wasiModule from 'node:wasi';
import { testReadOnlyOpen } from './wasi-preview1-readonly-open-test.js';
import { testDirectoryRefresh } from './wasi-preview1-directory-refresh-test.js';
import { testLifecycleErrors } from './wasi-preview1-lifecycle-error-test.js';
import { testNonblockingPathOpen } from './wasi-preview1-nonblocking-open-test.js';
import { testNonblockingStdio } from './wasi-preview1-nonblocking-stdio-test.js';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import commandModule from './wasi-preview1-command.wasm';
import {
  createAsyncStorage,
  createMemoryStorage,
} from './wasi-test-storage.js';
import {
  createSparseStorage,
  SPARSE_ATIME_NS,
  SPARSE_MTIME_NS,
  SPARSE_OFFSET,
} from './wasi-preview1-sparse-storage.js';
import {
  createReactor,
  createStdio,
  deferred,
  readBytes,
  readStrings,
} from './wasi-preview1-test-support.js';

const seed = Uint8Array.of(0x53, 0x45, 0x45, 0x44, 0x3a);
const input = Uint8Array.of(0x00, 0xff, 0x41);
const commandOutput = Uint8Array.of(0x00, 0xff, 0x41);

export const wasiPreview1Test = {
  async test() {
    ok(typeof wasiModule.WASI === 'function');
    ok(typeof wasiModule.AsyncWASI === 'function');

    await testReadOnlyOpen();
    await testDirectoryRefresh();
    await testLifecycleErrors();
    await testNonblockingPathOpen();
    await testNonblockingStdio();

    const store = createMemoryStorage({ 'note.bin': seed });
    const streams = createStdio(input);
    const { host, instance } = createReactor(store.storage, streams.stdio);
    try {
      ok(host.wasiImport.path_open);
      strictEqual(host.wasiImport.fd_read instanceof Function, true);
      host.initialize(instance);
      strictEqual(store.retainCount(store.storage.root), 1);
      strictEqual(instance.exports.getArgs(), 0);
      strictEqual(instance.exports.getEnv(), 0);
      deepStrictEqual(readStrings(instance.exports.memory, 64, 72, 4), [
        'guest',
        '--mode=test',
      ]);
      deepStrictEqual(readStrings(instance.exports.memory, 80, 88, 4), [
        'MODE=test',
      ]);

      strictEqual(instance.exports.openMissing(), 44);
      strictEqual(instance.exports.readFault(), 21);
      strictEqual(instance.exports.clockInfo(), 0);
      const clocks = new DataView(instance.exports.memory.buffer);
      strictEqual(clocks.getBigUint64(48, true), 1_000_000n);
      strictEqual(clocks.getBigUint64(56, true), 1_000n);
      strictEqual(clocks.getBigUint64(448, true) % 1_000_000n, 0n);
      strictEqual(clocks.getBigUint64(456, true) % 1_000n, 0n);
      instance.exports.memory.grow(1);
      strictEqual(instance.exports.randomLarge(), 0);
      strictEqual(instance.exports.exchange(), 0);
      deepStrictEqual(
        readBytes(instance.exports.memory, 1024, seed.byteLength),
        seed
      );
      strictEqual(
        new DataView(instance.exports.memory.buffer).getUint32(40, true),
        seed.byteLength
      );
      strictEqual(
        new DataView(instance.exports.memory.buffer).getUint32(44, true),
        input.byteLength
      );
      deepStrictEqual(
        store.readFile('note.bin'),
        new Uint8Array([...seed, ...input])
      );
      deepStrictEqual(streams.output(), new Uint8Array([...seed, ...input]));
      strictEqual(instance.exports.readEof(), 0);
      strictEqual(
        new DataView(instance.exports.memory.buffer).getUint32(20, true),
        0
      );
      strictEqual(store.retainCount(store.inodeFor('note.bin')), 1);
      strictEqual(instance.exports.renumberAndClose(), 0);
      strictEqual(store.retainCount(store.inodeFor('note.bin')), 0);
      strictEqual(instance.exports.openCreate(), 0);
      const createdInode = store.inodeFor('new.bin');
      strictEqual(store.retainCount(createdInode), 1);
      strictEqual(instance.exports.renameCreated(), 0);
      strictEqual(store.inodeFor('renamed.bin'), createdInode);
      strictEqual(instance.exports.unlinkRenamed(), 0);
      throws(() => store.inodeFor('renamed.bin'), { code: 'ENOENT' });
      strictEqual(store.retainCount(createdInode), 1);
      strictEqual(instance.exports.renumberAndClose(), 0);
      throws(() => store.inodeFor('renamed.bin'), { code: 'ENOENT' });
      host.close();
      host.close();
      strictEqual(store.retainCount(store.storage.root), 0);
    } finally {
      host.close();
    }

    const sparseStore = createSparseStorage();
    const sparse = createReactor(sparseStore.storage, createStdio().stdio);
    try {
      sparse.host.initialize(sparse.instance);
      strictEqual(sparse.instance.exports.bigOffsets(), 0);
      const sparseMemory = new DataView(sparse.instance.exports.memory.buffer);
      strictEqual(sparseMemory.getBigUint64(32, true), SPARSE_OFFSET);
      strictEqual(sparseMemory.getUint32(20, true), 1);
      strictEqual(sparseMemory.getUint32(24, true), 1);
      strictEqual(sparseMemory.getUint8(2048), 0x5a);
      deepStrictEqual(sparseStore.observations.writes, [
        { offset: SPARSE_OFFSET, source: Uint8Array.of(0x5a) },
      ]);
      deepStrictEqual(sparseStore.observations.readOffsets, [SPARSE_OFFSET]);
      deepStrictEqual(sparseStore.observations.times, [
        { atimeNs: SPARSE_ATIME_NS, mtimeNs: SPARSE_MTIME_NS },
      ]);
      strictEqual(sparseMemory.getBigUint64(168, true), SPARSE_ATIME_NS);
      strictEqual(sparseMemory.getBigUint64(176, true), SPARSE_MTIME_NS);
      strictEqual(sparseMemory.getBigUint64(160, true), SPARSE_OFFSET + 1n);
      strictEqual(sparse.instance.exports.renumberAndClose(), 0);
    } finally {
      sparse.host.close();
    }

    const readOnlyStore = createMemoryStorage();
    const readOnly = createReactor(
      readOnlyStore.storage,
      createStdio().stdio,
      wasiModule.WASI,
      {
        mounts: [
          { path: '/data', storage: readOnlyStore.storage, readOnly: true },
        ],
      }
    );
    try {
      readOnly.host.initialize(readOnly.instance);
      strictEqual(readOnly.instance.exports.openCreate(), 76);
    } finally {
      readOnly.host.close();
    }

    const brokenStore = createMemoryStorage();
    brokenStore.storage.lookup = () => {
      throw new Error('provider exploded');
    };
    const broken = createReactor(brokenStore.storage, createStdio().stdio);
    try {
      broken.host.initialize(broken.instance);
      throws(() => broken.instance.exports.openMissing(), /provider exploded/);
    } finally {
      broken.host.close();
    }

    const { host: finalizer, instance: finalizerInstance } = createReactor(
      undefined,
      createStdio().stdio,
      wasiModule.WASI,
      { mounts: [] }
    );
    finalizer.finalizeBindings(finalizerInstance);
    strictEqual(finalizerInstance.exports.clockInfo(), 0);
    finalizer.close();

    const syncCommand = createStdio();
    const syncHost = new wasiModule.WASI({
      version: 'preview1',
      stdio: syncCommand.stdio,
    });
    const syncInstance = new WebAssembly.Instance(
      commandModule,
      syncHost.getImportObject()
    );
    strictEqual(syncHost.start(syncInstance), 7);
    deepStrictEqual(syncCommand.output(), commandOutput);

    const asyncCommand = createStdio(new Uint8Array(), true);
    const asyncHost = new wasiModule.AsyncWASI({
      version: 'preview1',
      stdio: asyncCommand.stdio,
    });
    const asyncCommandInstance = new WebAssembly.Instance(
      commandModule,
      asyncHost.getImportObject()
    );
    strictEqual(await asyncHost.start(asyncCommandInstance), 7);
    deepStrictEqual(asyncCommand.output(), commandOutput);

    const asyncStore = createMemoryStorage({ 'note.bin': seed });
    const readStarted = deferred();
    const writeStarted = deferred();
    const releaseRead = deferred();
    const releaseWrite = deferred();
    let delayedFirstRead = false;
    const delayedStorage = createAsyncStorage(
      asyncStore.storage,
      async (operation) => {
        if (operation === 'readInto' && !delayedFirstRead) {
          delayedFirstRead = true;
          readStarted.resolve();
          await releaseRead.promise;
        }
        if (operation === 'write') {
          writeStarted.resolve();
          await releaseWrite.promise;
        }
      }
    );
    const asyncStreams = createStdio(input);
    const { host: asyncWasi, instance: asyncInstance } = createReactor(
      delayedStorage,
      asyncStreams.stdio,
      wasiModule.AsyncWASI
    );
    try {
      await asyncWasi.initialize(asyncInstance);
      const running = asyncWasi.run(asyncInstance.exports.exchange);
      await Promise.race([
        readStarted.promise,
        running.then(() => {
          throw new Error('guest finished before the delayed read');
        }),
      ]);
      asyncInstance.exports.memory.grow(1);
      releaseRead.resolve();
      await Promise.race([
        writeStarted.promise,
        running.then(() => {
          throw new Error('guest finished before the delayed write');
        }),
      ]);
      asyncInstance.exports.memory.grow(1);
      releaseWrite.resolve();
      strictEqual(await running, 0);
      deepStrictEqual(
        asyncStore.readFile('note.bin'),
        new Uint8Array([...seed, ...input])
      );
      deepStrictEqual(
        asyncStreams.output(),
        new Uint8Array([...seed, ...input])
      );
      strictEqual(await asyncWasi.run(asyncInstance.exports.getArgs), 0);
      strictEqual(await asyncWasi.run(asyncInstance.exports.getEnv), 0);
      deepStrictEqual(readStrings(asyncInstance.exports.memory, 64, 72, 4), [
        'guest',
        '--mode=test',
      ]);
      deepStrictEqual(readStrings(asyncInstance.exports.memory, 80, 88, 4), [
        'MODE=test',
      ]);
      strictEqual(await asyncWasi.run(asyncInstance.exports.readEof), 0);
      strictEqual(
        new DataView(asyncInstance.exports.memory.buffer).getUint32(20, true),
        0
      );
      strictEqual(await asyncWasi.run(asyncInstance.exports.pollOnce), 0);
      const events = new DataView(asyncInstance.exports.memory.buffer);
      strictEqual(events.getUint32(640, true), 1);
      strictEqual(events.getBigUint64(608, true), 659918n);
      strictEqual(events.getUint16(616, true), 0);
      strictEqual(events.getUint8(618), 0);
      strictEqual(
        await asyncWasi.run(asyncInstance.exports.renumberAndClose),
        0
      );
      strictEqual(asyncStore.retainCount(asyncStore.inodeFor('note.bin')), 0);
      await asyncWasi.close();
      strictEqual(asyncStore.retainCount(asyncStore.storage.root), 0);
    } finally {
      releaseRead.resolve();
      releaseWrite.resolve();
      await asyncWasi.close();
    }
  },
};
