// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  deepStrictEqual,
  strictEqual,
  throws,
} from 'node-internal:internal_assert';
import {
  WasiDescriptorTable,
  RIGHTS,
  ALL_RIGHTS,
  FDFLAGS,
} from 'node-internal:internal_wasi_descriptors';
import { runSync } from 'node-internal:internal_wasi_calls';
import { WasiFileSystem } from 'node-internal:internal_wasi_fs';
import { WasiLifecycle } from 'node-internal:internal_wasi_lifecycle';
import { WasiError, WasiMemory } from 'node-internal:internal_wasi_memory';
import { validateOptions } from 'node-internal:internal_wasi_options';
import {
  makeStore,
  makeCalls,
  readFd,
  writePath,
} from 'test:wasi-descriptors-support';

const ELOOP = 32;
const ENOTCAPABLE = 76;

function createFileSystem(store) {
  const guest = new WebAssembly.Memory({ initial: 1 });
  const memory = new WasiMemory();
  memory.set(guest);
  const filesystem = new WasiFileSystem(
    memory,
    [{ path: '/', storage: store.storage }],
    []
  );
  runSync(filesystem.initialize());
  return { guest, memory, filesystem };
}

function openPath(
  filesystem,
  memory,
  guest,
  path,
  dirflags = 0,
  oflags = 0,
  rights = RIGHTS.FD_READ
) {
  const { pointer, length } = writePath(memory, path);
  runSync(
    filesystem.imports.path_open(
      3,
      dirflags,
      pointer,
      length,
      oflags,
      rights,
      0n,
      0,
      16
    )
  );
  return new DataView(guest.buffer).getUint32(16, true);
}

export function testInheritedTableAndFilesystemOwnership() {
  const store = makeStore();
  const memory = new WasiMemory();
  memory.set(new WebAssembly.Memory({ initial: 1 }));
  const inherited = new WasiDescriptorTable();
  store.storage.retain(store.inode);
  const fd = inherited.allocate({
    kind: 'file',
    mount: {
      id: 0,
      path: '/',
      storage: store.storage,
      root: store.root,
      readOnly: false,
      device: 1n,
    },
    inode: store.inode,
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
  });
  const borrowed = new WasiFileSystem(
    memory,
    [{ path: '/', storage: store.storage }],
    [],
    {
      table: inherited,
      ownership: 'borrowed',
    }
  );
  runSync(borrowed.initialize());
  strictEqual([...inherited.entries()].length, 1);
  strictEqual(inherited.has(fd), true);
  strictEqual(store.retainCount(store.inode), 1);
  runSync(borrowed.close());
  strictEqual(inherited.has(fd), true);
  strictEqual(store.retainCount(store.inode), 1);

  const ownedStore = makeStore();
  const ownedTable = new WasiDescriptorTable();
  ownedStore.storage.retain(ownedStore.inode);
  const ownedFd = ownedTable.allocate({
    kind: 'file',
    mount: {
      id: 0,
      path: '/',
      storage: ownedStore.storage,
      root: ownedStore.root,
      readOnly: false,
      device: 1n,
    },
    inode: ownedStore.inode,
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
  });
  const owned = new WasiFileSystem(
    memory,
    [{ path: '/', storage: ownedStore.storage }],
    [],
    {
      table: ownedTable,
      ownership: 'owned',
    }
  );
  runSync(owned.initialize());
  runSync(owned.close());
  strictEqual(ownedTable.has(ownedFd), false);
  strictEqual(ownedStore.retainCount(ownedStore.inode), 0);
  runSync(inherited.close(fd));
}

export function testPublicStdioIsBorrowed(WASI, AsyncWASI) {
  let streamClosed = 0;
  const stream = {
    readInto() {
      return 0;
    },
    write(bytes) {
      return bytes.byteLength;
    },
    close() {
      streamClosed++;
    },
  };
  const stdio = [stream, stream, stream];
  new WASI({ version: 'preview1', stdio }).close();
  strictEqual(streamClosed, 0);
  return new AsyncWASI({ version: 'preview1', stdio })
    .close()
    .then(() => strictEqual(streamClosed, 0));
}

export function testLifecycleUsesInheritedTable() {
  const store = makeStore();
  const table = new WasiDescriptorTable();
  store.storage.retain(store.inode);
  const fd = table.allocate({
    kind: 'file',
    mount: {
      id: 0,
      path: '/',
      storage: store.storage,
      root: store.root,
      readOnly: false,
      device: 1n,
    },
    inode: store.inode,
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
  });
  const lifecycle = new WasiLifecycle(
    validateOptions({
      version: 'preview1',
      preopens: { '/': '/host' },
    }),
    false,
    { table, ownership: 'borrowed' }
  );
  runSync(lifecycle.filesystem.initialize());
  strictEqual([...table.entries()].length, 1);
  strictEqual(table.has(fd), true);
  lifecycle.close();
  strictEqual(table.has(fd), true);
  runSync(table.close(fd));
}

export function testPathResolutionAndOpenRights() {
  const store = makeStore();
  const directory = store.addDirectory('dir');
  store.addFile('file', 'payload', directory);
  store.addSymlink('link', 'dir/');
  store.addSymlink('alias', 'data');
  const { guest, memory, filesystem } = createFileSystem(store);
  try {
    const fd = openPath(filesystem, memory, guest, 'link/file');
    const { calls } = makeCalls(filesystem.descriptors, guest);
    deepStrictEqual(
      new TextDecoder().decode(readFd(calls, guest, fd, 64, 16, 8)),
      'payload'
    );
    throws(
      () => openPath(filesystem, memory, guest, 'alias', 0, 0),
      (error) => error instanceof WasiError && error.errno === ELOOP
    );
    const followed = openPath(filesystem, memory, guest, 'alias', 1, 0);
    deepStrictEqual(
      new TextDecoder().decode(readFd(calls, guest, followed, 96, 16, 12)),
      'abcdef'
    );
  } finally {
    runSync(filesystem.close());
  }

  const deniedStore = makeStore('keep');
  const denied = createFileSystem(deniedStore);
  try {
    const parent = denied.filesystem.descriptors.get(3);
    parent.rightsBase &= ~RIGHTS.PATH_FILESTAT_SET_SIZE;
    throws(
      () =>
        openPath(
          denied.filesystem,
          denied.memory,
          denied.guest,
          'data',
          0,
          8,
          RIGHTS.FD_WRITE
        ),
      (error) => error instanceof WasiError && error.errno === ENOTCAPABLE
    );
    strictEqual(deniedStore.storage.stat(deniedStore.inode).size, 4n);
  } finally {
    runSync(denied.filesystem.close());
  }

  const allowedStore = makeStore('truncate me');
  const allowed = createFileSystem(allowedStore);
  try {
    const fd = openPath(
      allowed.filesystem,
      allowed.memory,
      allowed.guest,
      'data',
      0,
      8,
      RIGHTS.FD_WRITE
    );
    strictEqual(allowed.filesystem.descriptors.has(fd), true);
    strictEqual(allowedStore.storage.stat(allowedStore.inode).size, 0n);
  } finally {
    runSync(allowed.filesystem.close());
  }
}

export function testSyncFlagRights() {
  const store = makeStore();
  const { filesystem, memory } = createFileSystem(store);
  const parent = filesystem.descriptors.get(3);
  parent.rightsBase &= ~RIGHTS.FD_DATASYNC & ~RIGHTS.FD_SYNC;
  const { pointer, length } = writePath(memory, 'data');
  try {
    for (const flag of [FDFLAGS.DSYNC, FDFLAGS.RSYNC, FDFLAGS.SYNC]) {
      throws(
        () =>
          runSync(
            filesystem.imports.path_open(
              3,
              0,
              pointer,
              length,
              0,
              RIGHTS.FD_READ,
              0n,
              flag,
              16
            )
          ),
        (error) => error instanceof WasiError && error.errno === ENOTCAPABLE
      );
    }
  } finally {
    runSync(filesystem.close());
  }
}
