// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { strictEqual, throws } from 'node-internal:internal_assert';
import {
  WasiDescriptorTable,
  RIGHTS,
} from 'node-internal:internal_wasi_descriptors';
import { runSync } from 'node-internal:internal_wasi_calls';
import { WasiError } from 'node-internal:internal_wasi_memory';
import { makeCalls, makeStore, openFile } from 'test:wasi-descriptors-support';

export function testLargePartialTransfers() {
  const budget = 16 * 1024 * 1024;
  const requested = budget + 1;
  const table = new WasiDescriptorTable();
  let writeCount = 0;
  const fd = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ | RIGHTS.FD_WRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      readInto(target) {
        target.fill(0x5a);
        return target.byteLength;
      },
      write(source) {
        writeCount++;
        strictEqual(source.byteLength, budget);
        strictEqual(source[0], 0x5a);
        strictEqual(source[budget - 1], 0x5a);
        // A provider can grow memory before the syscall writes its result.
        guest.grow(1);
        strictEqual(source[0], 0x5a);
        return source.byteLength;
      },
    },
  });
  const guest = new WebAssembly.Memory({ initial: 258 });
  const { calls } = makeCalls(table, guest);
  const view = new DataView(guest.buffer);
  view.setUint32(0, 1024, true);
  view.setUint32(4, requested, true);
  strictEqual(runSync(calls.imports.fd_read(fd, 0, 1, 8)), 0);
  strictEqual(view.getUint32(8, true), budget);
  strictEqual(new Uint8Array(guest.buffer)[1024 + budget - 1], 0x5a);
  strictEqual(new Uint8Array(guest.buffer)[1024 + budget], 0);
  strictEqual(runSync(calls.imports.fd_write(fd, 0, 1, 8)), 0);
  strictEqual(new DataView(guest.buffer).getUint32(8, true), budget);
  strictEqual(writeCount, 1);
  runSync(table.closeAll());
}

export function testPositionalRightsAndTell() {
  const store = makeStore();
  const table = new WasiDescriptorTable();
  const fd = openFile(table, store, {
    rightsBase: RIGHTS.FD_READ | RIGHTS.FD_WRITE | RIGHTS.FD_TELL,
  });
  const { calls, guest } = makeCalls(table);
  const view = new DataView(guest.buffer);
  view.setUint32(0, 64, true);
  view.setUint32(4, 1, true);
  const denied = (error) => error instanceof WasiError && error.errno === 76;
  throws(() => runSync(calls.imports.fd_pread(fd, 0, 1, 0n, 8)), denied);
  throws(() => runSync(calls.imports.fd_pwrite(fd, 0, 1, 0n, 8)), denied);
  strictEqual(runSync(calls.imports.fd_seek(fd, 0n, 1, 16)), 0);
  strictEqual(view.getBigUint64(16, true), 0n);
  const seekable = openFile(table, store, { rightsBase: RIGHTS.FD_SEEK });
  strictEqual(runSync(calls.imports.fd_tell(seekable, 16)), 0);
  runSync(table.closeAll());
}
