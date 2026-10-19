// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AsyncWASI, WASI } from 'node:wasi';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { createReactor, deferred } from './wasi-preview1-test-support.js';

const NONBLOCK = 4;
const EAGAIN = 6;
const ENOTSUP = 58;

export async function testNonblockingStdio() {
  for (const Host of [WASI, AsyncWASI]) {
    await testNonblockingReadAndRenumberedWrite(Host);
    await testNonOptedInProvider(Host);
    await testPromiseContractBreach(Host);
  }
  await testBlockingReadAfterClearingFlags();
}

async function testNonblockingReadAndRenumberedWrite(Host) {
  const readFlags = [];
  const writeFlags = [];
  let readCalls = 0;
  const streams = [
    {
      supportsNonblocking: true,
      readInto(target, flags) {
        readFlags.push(flags);
        if ((flags & NONBLOCK) === 0) {
          target[0] = 0xc3;
          return 1;
        }
        if (readCalls++ === 0) throw errnoError('EAGAIN');
        if (readCalls === 2) {
          target.set([0xa1, 0xb2]);
          return 2;
        }
        throw errnoError('EAGAIN');
      },
    },
    {
      supportsNonblocking: true,
      write(source, flags) {
        writeFlags.push(flags);
        return source.byteLength;
      },
    },
    { write: (source) => source.byteLength },
  ];
  const { host, instance } = createReactor(undefined, streams, Host, {
    mounts: [],
  });
  const asyncMode = Host === AsyncWASI;
  const call = (name, ...args) =>
    asyncMode
      ? host.run(instance.exports[name], ...args)
      : instance.exports[name](...args);
  const memory = instance.exports.memory;
  const view = new DataView(memory.buffer);

  try {
    await host.initialize(instance);
    strictEqual(await call('setFdFlags', 0, NONBLOCK), 0);
    strictEqual(await call('fdStat', 0, 64), 0);
    strictEqual(view.getUint16(66, true), NONBLOCK);

    view.setUint32(96, 256, true);
    view.setUint32(100, 2, true);
    new Uint8Array(memory.buffer, 256, 4).fill(0x5a);
    view.setUint32(80, 0xffffffff, true);
    strictEqual(await call('readFd', 0, 96, 1, 80), EAGAIN);
    strictEqual(view.getUint32(80, true), 0xffffffff);
    deepStrictEqual(
      new Uint8Array(memory.buffer, 256, 2),
      Uint8Array.of(0x5a, 0x5a)
    );

    view.setUint32(104, 258, true);
    view.setUint32(108, 2, true);
    strictEqual(await call('readFd', 0, 96, 2, 80), 0);
    strictEqual(view.getUint32(80, true), 2);
    deepStrictEqual(
      new Uint8Array(memory.buffer, 256, 4),
      Uint8Array.of(0xa1, 0xb2, 0x5a, 0x5a)
    );

    strictEqual(await call('setFdFlags', 0, 0), 0);
    strictEqual(await call('readFd', 0, 96, 1, 80), 0);
    strictEqual(view.getUint32(80, true), 1);
    strictEqual(new Uint8Array(memory.buffer, 256, 1)[0], 0xc3);
    deepStrictEqual(readFlags, [NONBLOCK, NONBLOCK, NONBLOCK, 0]);

    strictEqual(await call('setFdFlags', 0, NONBLOCK), 0);
    strictEqual(await call('renumberFd', 0, 3), 8);
    strictEqual(await call('fdStat', 0, 64), 0);
    strictEqual(await call('renumberFd', 0, 2), 0);
    strictEqual(await call('fdStat', 2, 64), 0);
    strictEqual(view.getUint16(66, true), NONBLOCK);
    strictEqual(await call('setFdFlags', 2, 0), 0);
    strictEqual(await call('readFd', 2, 96, 1, 80), 0);
    deepStrictEqual(readFlags, [NONBLOCK, NONBLOCK, NONBLOCK, 0, 0]);

    strictEqual(await call('setFdFlags', 1, NONBLOCK), 0);
    strictEqual(await call('renumberFd', 1, 2), 0);
    strictEqual(await call('fdStat', 2, 64), 0);
    strictEqual(view.getUint16(66, true), NONBLOCK);

    view.setUint32(96, 272, true);
    view.setUint32(100, 2, true);
    new Uint8Array(memory.buffer, 272, 2).set([0x51, 0x52]);
    strictEqual(await call('setFdFlags', 2, 0), 0);
    strictEqual(await call('writeFd', 2, 96, 1, 80), 0);
    strictEqual(view.getUint32(80, true), 2);
    strictEqual(await call('setFdFlags', 2, NONBLOCK), 0);
    strictEqual(await call('writeFd', 2, 96, 1, 80), 0);
    strictEqual(view.getUint32(80, true), 2);
    deepStrictEqual(writeFlags, [0, NONBLOCK]);
  } finally {
    await host.close();
  }
}

async function testNonOptedInProvider(Host) {
  let readCalls = 0;
  const streams = [
    {
      readInto() {
        readCalls++;
        return 0;
      },
    },
    { write: (source) => source.byteLength },
    { write: (source) => source.byteLength },
  ];
  const { host, instance } = createReactor(undefined, streams, Host, {
    mounts: [],
  });
  const asyncMode = Host === AsyncWASI;
  const call = (name, ...args) =>
    asyncMode
      ? host.run(instance.exports[name], ...args)
      : instance.exports[name](...args);
  try {
    await host.initialize(instance);
    strictEqual(await call('setFdFlags', 0, NONBLOCK), ENOTSUP);
    strictEqual(await call('fdStat', 0, 64), 0);
    strictEqual(
      new DataView(instance.exports.memory.buffer).getUint16(66, true),
      0
    );
    strictEqual(readCalls, 0);
  } finally {
    await host.close();
  }
}

async function testPromiseContractBreach(Host) {
  const readFlags = [];
  const writeFlags = [];
  const streams = [
    {
      supportsNonblocking: true,
      readInto(_target, flags) {
        readFlags.push(flags);
        return Promise.reject(new Error('unexpected async read'));
      },
    },
    {
      supportsNonblocking: true,
      write(_source, flags) {
        writeFlags.push(flags);
        return Promise.reject(new Error('unexpected async write'));
      },
    },
    { write: (source) => source.byteLength },
  ];
  const { host, instance } = createReactor(undefined, streams, Host, {
    mounts: [],
  });
  const asyncMode = Host === AsyncWASI;
  const call = (name, ...args) =>
    asyncMode
      ? host.run(instance.exports[name], ...args)
      : instance.exports[name](...args);
  const memory = instance.exports.memory;
  const view = new DataView(memory.buffer);

  try {
    await host.initialize(instance);
    strictEqual(await call('setFdFlags', 0, NONBLOCK), 0);
    strictEqual(await call('setFdFlags', 1, NONBLOCK), 0);

    view.setUint32(96, 256, true);
    view.setUint32(100, 1, true);
    view.setUint32(80, 0xffffffff, true);
    strictEqual(await call('readFd', 0, 96, 1, 80), ENOTSUP);
    strictEqual(view.getUint32(80, true), 0xffffffff);

    new Uint8Array(memory.buffer, 256, 1)[0] = 0x44;
    strictEqual(await call('writeFd', 1, 96, 1, 80), ENOTSUP);
    strictEqual(view.getUint32(80, true), 0xffffffff);
    deepStrictEqual(readFlags, [NONBLOCK]);
    deepStrictEqual(writeFlags, [NONBLOCK]);
  } finally {
    await host.close();
  }
}

async function testBlockingReadAfterClearingFlags() {
  const started = deferred();
  const release = deferred();
  const readFlags = [];
  const streams = [
    {
      supportsNonblocking: true,
      readInto(target, flags) {
        readFlags.push(flags);
        if ((flags & NONBLOCK) !== 0) throw errnoError('EAGAIN');
        started.resolve();
        return release.promise.then(() => {
          target[0] = 0x77;
          return 1;
        });
      },
    },
    { write: (source) => source.byteLength },
    { write: (source) => source.byteLength },
  ];
  const { host, instance } = createReactor(undefined, streams, AsyncWASI, {
    mounts: [],
  });
  let blockingRead;
  const memory = instance.exports.memory;
  const view = new DataView(memory.buffer);

  try {
    await host.initialize(instance);
    view.setUint32(96, 256, true);
    view.setUint32(100, 1, true);
    strictEqual(await host.run(instance.exports.setFdFlags, 0, NONBLOCK), 0);
    strictEqual(await host.run(instance.exports.readFd, 0, 96, 1, 80), EAGAIN);
    strictEqual(await host.run(instance.exports.setFdFlags, 0, 0), 0);

    blockingRead = host.run(instance.exports.readFd, 0, 96, 1, 80);
    await started.promise;
    release.resolve();
    strictEqual(await blockingRead, 0);
    strictEqual(view.getUint32(80, true), 1);
    strictEqual(new Uint8Array(memory.buffer, 256, 1)[0], 0x77);
    deepStrictEqual(readFlags, [NONBLOCK, 0]);
  } finally {
    release.resolve();
    if (blockingRead !== undefined) await Promise.allSettled([blockingRead]);
    await host.close();
  }
}

function errnoError(code) {
  return Object.assign(new Error(code), { code });
}
