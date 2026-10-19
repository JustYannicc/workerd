// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMemoryStorage } from './wasi-test-storage.js';

export const SPARSE_OFFSET = 9007199254740995n;
export const SPARSE_ATIME_NS = 9007199254740995n;
export const SPARSE_MTIME_NS = 9007199254741004n;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function createSparseStorage() {
  const fixture = createMemoryStorage({ 'note.bin': new Uint8Array() });
  const inode = fixture.inodeFor('note.bin');
  const originalStat = fixture.storage.stat;
  const data = new Map();
  const times = { atimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n };
  const observations = { readOffsets: [], writes: [], times: [] };

  fixture.storage.stat = (target) => {
    const stat = originalStat(target);
    if (target !== inode) return stat;
    return {
      ...stat,
      size: SPARSE_OFFSET + 1n,
      atimeNs: times.atimeNs,
      mtimeNs: times.mtimeNs,
      ctimeNs: times.ctimeNs,
    };
  };
  fixture.storage.readInto = (target, offset, output) => {
    if (target !== inode) return fail('EBADF');
    observations.readOffsets.push(offset);
    let count = 0;
    while (count < output.byteLength) {
      const byte = data.get(offset + BigInt(count));
      if (byte === undefined) break;
      output[count++] = byte;
    }
    return count;
  };
  fixture.storage.write = (target, offset, source) => {
    if (target !== inode) return fail('EBADF');
    observations.writes.push({ offset, source: source.slice() });
    for (let index = 0; index < source.byteLength; index++) {
      data.set(offset + BigInt(index), source[index]);
    }
    return source.byteLength;
  };
  fixture.storage.setTimes = (target, update) => {
    if (target !== inode) return fail('EBADF');
    observations.times.push({ ...update });
    if (update.atimeNs !== undefined) times.atimeNs = update.atimeNs;
    if (update.mtimeNs !== undefined) times.mtimeNs = update.mtimeNs;
  };

  return {
    ...fixture,
    inode,
    observations,
    readSparse(offset, length) {
      return Uint8Array.from(
        Array.from(
          { length },
          (_, index) => data.get(offset + BigInt(index)) ?? 0
        )
      );
    },
  };
}
