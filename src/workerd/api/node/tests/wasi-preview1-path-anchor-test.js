// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  deepStrictEqual,
  strictEqual,
  throws,
} from 'node-internal:internal_assert';
import { complete, runSync } from 'node-internal:internal_wasi_calls';
import { WasiError } from 'node-internal:internal_wasi_memory';
import { WasiPathResolver } from 'node-internal:internal_wasi_paths';
import { WasiPathCalls } from 'node-internal:internal_wasi_path_calls';
import {
  ALL_RIGHTS,
  RIGHTS,
  WasiDescriptorTable,
} from 'node-internal:internal_wasi_descriptors';
import {
  makeCalls,
  makeMount,
  makeStore,
  writePath,
} from 'test:wasi-descriptors-support';

export function testMovedDirectoryParent() {
  const store = makeStore();
  const parent = store.addDirectory('old-parent');
  const destination = store.addDirectory('new-parent');
  const child = store.addDirectory('child', parent);
  const paths = new WasiPathResolver(complete);
  const anchor = {
    mount: makeMount(store),
    inode: child,
    ancestors: [store.root, parent, child],
    pathComponents: ['old-parent', 'child'],
  };
  strictEqual(runSync(paths.resolve(anchor, '..', true)).inode, parent);
  store.storage.rename(parent, 'child', parent, 'renamed');
  strictEqual(
    runSync(paths.validateAnchor(anchor)).pathComponents.join('/'),
    'old-parent/renamed'
  );
  strictEqual(
    runSync(paths.resolve(anchor, '.', true)).pathComponents.join('/'),
    'old-parent/renamed'
  );
  store.storage.rename(store.root, 'old-parent', store.root, 'renamed-parent');
  strictEqual(
    runSync(paths.validateAnchor(anchor)).pathComponents.join('/'),
    'renamed-parent/renamed'
  );
  strictEqual(runSync(paths.resolve(anchor, '..', true)).inode, parent);
  store.storage.rename(parent, 'renamed', destination, 'child');
  throws(
    () => runSync(paths.resolve(anchor, '..', true)),
    (error) => error instanceof WasiError && error.errno === 72
  );
  throws(
    () => runSync(paths.validateAnchor(anchor)),
    (error) => error instanceof WasiError && error.errno === 72
  );
  throws(
    () => runSync(paths.resolve(anchor, '.', true)),
    (error) => error instanceof WasiError && error.errno === 72
  );
}

export function testPathPolicyBlocksHiddenSymlinkTraversal() {
  const store = makeStore();
  const hidden = store.addDirectory('m');
  const outside = store.addDirectory('outside');
  const target = store.addFile('target', 'preserved', outside);
  store.addSymlink('shortcut', '/m/jump');
  store.addSymlink('jump', '/outside', hidden);
  const mount = makeMount(store);
  const anchor = {
    mount,
    inode: store.root,
    ancestors: [store.root],
    pathComponents: [],
  };
  strictEqual(
    runSync(
      new WasiPathResolver(complete).resolve(anchor, 'shortcut/target', true)
    ).inode,
    target
  );

  let hiddenLookups = 0;
  const lookup = store.storage.lookup;
  store.storage.lookup = (parent, name) => {
    if (parent === hidden || (parent === store.root && name === 'm')) {
      hiddenLookups++;
    }
    return lookup(parent, name);
  };
  const paths = new WasiPathResolver(complete, (_mount, components) => {
    if (components[0] === 'm') throw new WasiError(76);
  });
  const table = new WasiDescriptorTable();
  store.storage.retain(store.root);
  const rootFd = table.allocate({
    kind: 'directory',
    mount,
    inode: store.root,
    capabilityRoot: store.root,
    ancestors: [store.root],
    pathComponents: [],
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
  });
  const { memory } = makeCalls(table);
  const calls = new WasiPathCalls(memory, table, paths);
  const path = writePath(memory, 'shortcut/target');
  const denied = (operation) =>
    throws(
      () => runSync(operation()),
      (error) => error instanceof WasiError && error.errno === 76
    );
  try {
    denied(() =>
      calls.imports.path_open(
        rootFd,
        1,
        path.pointer,
        path.length,
        8,
        RIGHTS.FD_WRITE,
        0n,
        0,
        16
      )
    );
    denied(() =>
      calls.imports.path_unlink_file(rootFd, path.pointer, path.length)
    );
    const missing = writePath(memory, 'shortcut/new');
    denied(() =>
      calls.imports.path_open(
        rootFd,
        1,
        missing.pointer,
        missing.length,
        1,
        RIGHTS.FD_WRITE,
        0n,
        0,
        16
      )
    );
    strictEqual(hiddenLookups, 0);
    strictEqual(store.storage.lookup(outside, 'target'), target);
    throws(
      () => store.storage.lookup(outside, 'new'),
      (error) => error.code === 'ENOENT'
    );
    const bytes = new Uint8Array(9);
    strictEqual(store.storage.readInto(target, 0n, bytes), 9);
    strictEqual(new TextDecoder().decode(bytes), 'preserved');
  } finally {
    runSync(table.closeAll());
  }
}

export function testPathPolicyChecksRefreshedAnchorsAndParentLeaves() {
  const store = makeStore();
  const directory = store.addDirectory('allowed');
  const mount = makeMount(store);
  const anchor = {
    mount,
    inode: directory,
    ancestors: [store.root, directory],
    pathComponents: ['allowed'],
  };
  const checked = [];
  const paths = new WasiPathResolver(complete, (currentMount, components) => {
    strictEqual(currentMount, mount);
    checked.push([...components]);
    if (components[0] === 'm') throw new WasiError(76);
  });
  deepStrictEqual(runSync(paths.validateAnchor(anchor)).pathComponents, [
    'allowed',
  ]);
  store.storage.rename(store.root, 'allowed', store.root, 'm');
  let hiddenReads = 0;
  const readdir = store.storage.readdir;
  store.storage.readdir = (inode) => {
    if (inode === directory) hiddenReads++;
    return readdir(inode);
  };
  checked.length = 0;
  throws(
    () => runSync(paths.validateAnchor(anchor)),
    (error) => error instanceof WasiError && error.errno === 76
  );
  deepStrictEqual(checked, [[], ['m']]);
  strictEqual(hiddenReads, 0);

  const root = {
    mount,
    inode: store.root,
    ancestors: [store.root],
    pathComponents: [],
  };
  store.storage.unlink(store.root, 'm', { directory: true });
  checked.length = 0;
  throws(
    () => runSync(paths.resolveParent(root, 'm')),
    (error) => error instanceof WasiError && error.errno === 76
  );
  deepStrictEqual(checked, [[], ['m']]);
  const rootDenied = new WasiPathResolver(complete, () => {
    throw new WasiError(76);
  });
  throws(
    () => runSync(rootDenied.validateAnchor(root)),
    (error) => error instanceof WasiError && error.errno === 76
  );
}
