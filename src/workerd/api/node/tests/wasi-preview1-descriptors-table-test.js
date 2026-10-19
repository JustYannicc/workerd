// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  deepStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} from 'node-internal:internal_assert';
import {
  WasiDescriptorTable,
  RIGHTS,
  ALL_RIGHTS,
  FDFLAGS,
} from 'node-internal:internal_wasi_descriptors';
import { runAsync, runSync } from 'node-internal:internal_wasi_calls';
import { WasiError } from 'node-internal:internal_wasi_memory';
import {
  makeStore,
  openFile,
  makeCalls,
  readFd,
} from 'test:wasi-descriptors-support';

const ENOTCAPABLE = 76;
const encoder = new TextEncoder();

export function testFinalReferenceAndSharedCursor() {
  const store = makeStore();
  const table = new WasiDescriptorTable();
  const fd = openFile(table, store);
  const duplicate = table.duplicate(fd);
  const child = table.fork(new Map([[fd, 20]]), { exec: false });
  store.storage.unlink(store.root, 'data', { directory: false });
  strictEqual(store.has(store.inode), true);
  strictEqual(store.retainCount(store.inode), 1);

  const { guest, calls } = makeCalls(table);
  runSync(calls.imports.fd_fdstat_set_flags(fd, FDFLAGS.APPEND));
  strictEqual(table.get(duplicate).flags, FDFLAGS.APPEND);
  strictEqual(child.get(20).flags, FDFLAGS.APPEND);
  deepStrictEqual(readFd(calls, guest, fd, 64, 2, 8), encoder.encode('ab'));
  deepStrictEqual(
    readFd(calls, guest, duplicate, 64, 2, 12),
    encoder.encode('cd')
  );
  const childCalls = makeCalls(child);
  deepStrictEqual(
    readFd(childCalls.calls, childCalls.guest, 20, 64, 2, 8),
    encoder.encode('ef')
  );

  runSync(table.close(fd));
  runSync(table.close(duplicate));
  strictEqual(store.has(store.inode), true);
  runSync(child.close(20));
  strictEqual(store.has(store.inode), false);
  strictEqual(store.releaseCount, 1);
}

export async function testOrderedAsyncCursor() {
  const store = makeStore('XY');
  const table = new WasiDescriptorTable();
  const fd = openFile(table, store);
  const duplicate = table.duplicate(fd);
  const readOffsets = [];
  const baseRead = store.storage.readInto;
  let releaseFirst;
  let reportReadStarted;
  const readStarted = new Promise((resolve) => {
    reportReadStarted = resolve;
  });
  store.storage.readInto = (inode, offset, target) => {
    readOffsets.push(offset);
    if (offset === 0n) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(baseRead(inode, offset, target));
        reportReadStarted();
      });
    }
    return baseRead(inode, offset, target);
  };

  const { guest, calls } = makeCalls(table);
  const view = new DataView(guest.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 1, true);
  view.setUint32(16, 65, true);
  view.setUint32(20, 1, true);
  const first = runAsync(calls.imports.fd_read(fd, 0, 1, 8));
  const second = runAsync(calls.imports.fd_read(duplicate, 16, 1, 12));
  await readStarted;
  deepStrictEqual(readOffsets, [0n]);
  ok(releaseFirst !== undefined);
  releaseFirst();
  await Promise.all([first, second]);
  deepStrictEqual(readOffsets, [0n, 1n]);
  deepStrictEqual(new Uint8Array(guest.buffer, 64, 1), Uint8Array.of(0x58));
  deepStrictEqual(new Uint8Array(guest.buffer, 65, 1), Uint8Array.of(0x59));
  strictEqual(view.getUint32(8, true), 1);
  strictEqual(view.getUint32(12, true), 1);
  strictEqual(table.get(fd).offset, 2n);
  runSync(table.close(fd));
  runSync(table.close(duplicate));
}

export function testRightsAndExecActions() {
  const storeA = makeStore('A');
  const storeB = makeStore('B');
  const storeC = makeStore('C');
  const parent = new WasiDescriptorTable();
  const a = openFile(parent, storeA);
  const b = openFile(parent, storeB, { closeOnExec: true });
  const c = openFile(parent, storeC, { closeOnExec: true });
  const restricted = parent.duplicate(a, {
    rightsBase: RIGHTS.FD_READ,
    rightsInheriting: 0n,
    closeOnExec: true,
  });
  strictEqual(parent.get(a).closeOnExec, false);
  strictEqual(parent.get(restricted).rightsBase, RIGHTS.FD_READ);
  strictEqual(parent.get(a).rightsBase, ALL_RIGHTS);
  const calls = makeCalls(parent).calls;
  throws(
    () => runSync(calls.imports.fd_write(restricted, 0, 0, 8)),
    (error) => error instanceof WasiError && error.errno === ENOTCAPABLE
  );
  runSync(calls.imports.fd_fdstat_set_rights(restricted, RIGHTS.FD_READ, 0n));
  strictEqual(parent.get(a).rightsBase, ALL_RIGHTS);

  const child = parent.fork(
    new Map([
      [a, 30],
      [b, 31],
      [c, 32],
    ]),
    { exec: false }
  );
  strictEqual(child.has(31), true);
  strictEqual(child.get(31).closeOnExec, true);
  runSync(child.duplicateTo(31, 30));
  runSync(child.duplicateTo(30, 31));
  strictEqual(child.get(30).closeOnExec, false);
  strictEqual(child.get(31).closeOnExec, false);
  runSync(child.closeOnExecSweep());
  strictEqual(child.has(32), false);
  const childCalls = makeCalls(child);
  deepStrictEqual(
    readFd(childCalls.calls, childCalls.guest, 30, 64, 1, 8),
    encoder.encode('B')
  );
  deepStrictEqual(
    readFd(childCalls.calls, childCalls.guest, 31, 64, 1, 12),
    new Uint8Array()
  );
  strictEqual(child.get(30).offset, child.get(31).offset);
  runSync(child.closeAll());
  runSync(parent.closeAll());
}

export async function testDuplicateToCleanupRace() {
  const sourceStore = makeStore('source');
  const targetStore = makeStore('target');
  const table = new WasiDescriptorTable();
  let sourceCleanupCount = 0;
  const sourceFd = openFile(table, sourceStore, {
    onLastClose() {
      sourceCleanupCount++;
    },
  });
  const targetFd = openFile(table, targetStore);
  let rejectRelease;
  let reportReleaseStarted;
  const releaseStarted = new Promise((resolve) => {
    reportReleaseStarted = resolve;
  });
  targetStore.storage.release = () =>
    new Promise((_, reject) => {
      rejectRelease = reject;
      reportReleaseStarted();
    });

  const failure = new Error('target release failed');
  const duplicating = runAsync(table.duplicateTo(sourceFd, targetFd));
  await releaseStarted;
  await runAsync(table.close(sourceFd));
  rejectRelease(failure);
  await rejects(duplicating, (error) => error === failure);
  strictEqual(table.has(sourceFd), false);
  strictEqual(table.has(targetFd), false);
  strictEqual(sourceCleanupCount, 1);
  strictEqual(sourceStore.releaseCount, 1);
  strictEqual(sourceStore.retainCount(sourceStore.inode), 0);
}

export function testRenumberSelfRequiresOpenFd() {
  const table = new WasiDescriptorTable();
  throws(
    () => runSync(table.renumber(99, 99)),
    (error) => error instanceof WasiError && error.errno === 8
  );
}
