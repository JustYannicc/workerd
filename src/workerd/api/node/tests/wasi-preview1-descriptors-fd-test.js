// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { strictEqual, throws } from 'node-internal:internal_assert';
import {
  WasiDescriptorTable,
  RIGHTS,
  ALL_RIGHTS,
} from 'node-internal:internal_wasi_descriptors';
import { runSync } from 'node-internal:internal_wasi_calls';
import {
  makeStore,
  makeMount,
  openFile,
  makeCalls,
} from 'test:wasi-descriptors-support';

function makePipe(table) {
  const bytes = [];
  let readers = 1;
  let writers = 1;
  let readCloses = 0;
  let writeCloses = 0;
  const reader = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      readInto(target) {
        if (bytes.length === 0) {
          if (writers > 0)
            throw Object.assign(new Error('empty pipe'), { code: 'EAGAIN' });
          return 0;
        }
        const count = Math.min(target.byteLength, bytes.length);
        target.set(bytes.splice(0, count));
        return count;
      },
    },
    onLastClose() {
      readCloses++;
      readers--;
    },
  });
  const writer = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_WRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      write(source) {
        if (readers === 0)
          throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        bytes.push(...source);
        return source.byteLength;
      },
    },
    onLastClose() {
      writeCloses++;
      writers--;
    },
  });
  return {
    reader,
    writer,
    counts: () => ({ readers, writers, readCloses, writeCloses }),
  };
}

export function testPipeFinalAliasesAndCloseFailures() {
  const table = new WasiDescriptorTable();
  const pipe = makePipe(table);
  const writerAlias = table.duplicate(pipe.writer);
  const child = table.fork(new Map([[pipe.writer, 50]]), { exec: false });
  const { guest, calls } = makeCalls(table);
  const view = new DataView(guest.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 1, true);
  runSync(table.close(pipe.writer));
  strictEqual(pipe.counts().writeCloses, 0);
  throws(() => runSync(calls.imports.fd_read(pipe.reader, 0, 1, 8)), {
    code: 'EAGAIN',
  });
  runSync(table.close(writerAlias));
  strictEqual(pipe.counts().writeCloses, 0);
  runSync(child.close(50));
  strictEqual(pipe.counts().writeCloses, 1);
  runSync(calls.imports.fd_read(pipe.reader, 0, 1, 8));
  strictEqual(new DataView(guest.buffer).getUint32(8, true), 0);
  runSync(table.close(pipe.reader));
  strictEqual(pipe.counts().readCloses, 1);

  const second = makePipe(table);
  const readerAlias = table.duplicate(second.reader);
  runSync(table.close(second.reader));
  strictEqual(second.counts().readCloses, 0);
  const io = makeCalls(table);
  new DataView(io.guest.buffer).setUint32(0, 64, true);
  new DataView(io.guest.buffer).setUint32(4, 1, true);
  new Uint8Array(io.guest.buffer, 64, 1).set([0x41]);
  runSync(io.calls.imports.fd_write(second.writer, 0, 1, 8));
  runSync(table.close(readerAlias));
  strictEqual(second.counts().readCloses, 1);
  throws(() => runSync(io.calls.imports.fd_write(second.writer, 0, 1, 8)), {
    code: 'EPIPE',
  });
  runSync(table.close(second.writer));
  strictEqual(second.counts().writeCloses, 1);

  const failed = makeStore('failure');
  const failingTable = new WasiDescriptorTable();
  let cleanupCount = 0;
  const failingFd = openFile(failingTable, failed, {
    onLastClose() {
      cleanupCount++;
      throw new Error('close failed');
    },
  });
  throws(() => runSync(failingTable.close(failingFd)), /close failed/);
  strictEqual(failingTable.has(failingFd), false);
  runSync(failingTable.closeAll());
  strictEqual(cleanupCount, 1);
  strictEqual(failed.retainCount(failed.inode), 0);
}

export function testReaddirPartialCookie() {
  const store = makeStore();
  const table = new WasiDescriptorTable();
  store.storage.retain(store.root);
  const fd = table.allocate({
    kind: 'directory',
    mount: makeMount(store),
    inode: store.root,
    capabilityRoot: store.root,
    ancestors: [store.root],
    pathComponents: [],
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
  });
  const { guest, calls } = makeCalls(table);
  const view = new DataView(guest.buffer);
  runSync(calls.imports.fd_readdir(fd, 128, 1, 0n, 8));
  strictEqual(view.getUint32(8, true), 1);
  strictEqual(new Uint8Array(guest.buffer, 128, 1)[0], 1);
  runSync(calls.imports.fd_readdir(fd, 128, 25, 0n, 8));
  strictEqual(view.getUint32(8, true), 25);
  strictEqual(view.getBigUint64(128, true), 1n);
  strictEqual(view.getUint32(144, true), 1);
  strictEqual(
    new TextDecoder().decode(new Uint8Array(guest.buffer, 152, 1)),
    '.'
  );
  runSync(table.close(fd));
}
