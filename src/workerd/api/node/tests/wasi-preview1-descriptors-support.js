// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ALL_RIGHTS } from 'node-internal:internal_wasi_descriptors';
import { WasiFdCalls } from 'node-internal:internal_wasi_fd_calls';
import { WasiMemory } from 'node-internal:internal_wasi_memory';
import { runSync } from 'node-internal:internal_wasi_calls';

const encoder = new TextEncoder();

export function makeStore(contents = 'abcdef') {
  let nextInode = 3n;
  const root = {
    inode: 1n,
    type: 'directory',
    children: new Map(),
    nlink: 1n,
    refs: 0,
  };
  const file = {
    inode: 2n,
    type: 'file',
    data: encoder.encode(contents),
    nlink: 1n,
    refs: 0,
  };
  root.children.set('data', file.inode);
  const nodes = new Map([
    [root.inode, root],
    [file.inode, file],
  ]);
  let releaseCount = 0;

  function get(inode) {
    const node = nodes.get(inode);
    if (node === undefined)
      throw Object.assign(new Error('missing inode'), { code: 'EBADF' });
    return node;
  }

  function addNode(parent, name, type, values = {}) {
    const directory = get(parent);
    if (directory.type !== 'directory')
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    if (directory.children.has(name))
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const node = {
      inode: nextInode++,
      type,
      nlink: 1n,
      refs: 0,
      ...(type === 'directory' ? { children: new Map() } : {}),
      ...(type === 'file' ? { data: new Uint8Array() } : {}),
      ...values,
    };
    directory.children.set(name, node.inode);
    nodes.set(node.inode, node);
    return node.inode;
  }

  const storage = {
    root: root.inode,
    lookup(parent, name) {
      const child = get(parent).children?.get(name);
      if (child === undefined)
        throw Object.assign(new Error('missing entry'), { code: 'ENOENT' });
      return child;
    },
    stat(inode) {
      const node = get(inode);
      return {
        type: node.type,
        size: BigInt(node.data?.byteLength ?? 0),
        nlink: node.nlink,
        atimeNs: 0n,
        mtimeNs: 0n,
        ctimeNs: 0n,
      };
    },
    readlink(inode) {
      const node = get(inode);
      if (node.type !== 'symlink')
        throw Object.assign(new Error('not a symlink'), { code: 'EINVAL' });
      return node.target;
    },
    readdir(inode) {
      const directory = get(inode);
      if (directory.type !== 'directory')
        throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return [...directory.children].map(([name, child]) => ({
        name,
        inode: child,
        type: get(child).type,
      }));
    },
    retain(inode) {
      get(inode).refs++;
    },
    release(inode) {
      releaseCount++;
      const node = get(inode);
      if (node.refs === 0)
        throw Object.assign(new Error('bad release'), { code: 'EINVAL' });
      node.refs--;
      if (node.nlink === 0n && node.refs === 0) nodes.delete(inode);
    },
    readInto(inode, offset, target) {
      const node = get(inode);
      if (node.type !== 'file')
        throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      const start = Number(offset);
      const count = Math.max(
        0,
        Math.min(target.byteLength, node.data.byteLength - start)
      );
      if (count > 0) target.set(node.data.subarray(start, start + count));
      return count;
    },
    write(inode, offset, source) {
      const node = get(inode);
      if (node.type !== 'file')
        throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      const start = Number(offset);
      const end = start + source.byteLength;
      if (end > node.data.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(node.data);
        node.data = grown;
      }
      node.data.set(source, start);
      return source.byteLength;
    },
    append(inode, source) {
      const offset = BigInt(get(inode).data.byteLength);
      storage.write(inode, offset, source);
      return { offset, bytesWritten: source.byteLength };
    },
    truncate(inode, size) {
      const node = get(inode);
      const data = new Uint8Array(Number(size));
      data.set(node.data.subarray(0, data.byteLength));
      node.data = data;
    },
    setTimes() {},
    sync() {},
    create(parent, name, options) {
      const directory = get(parent);
      const existing = directory.children?.get(name);
      if (existing !== undefined) {
        if (options.exclusive)
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        const node = get(existing);
        if (node.type === 'file' && options.type === 'file') {
          node.refs++;
          return existing;
        }
        throw Object.assign(new Error('incompatible existing entry'), {
          code: node.type === 'directory' ? 'EISDIR' : 'ELOOP',
        });
      }
      if (options.type === 'symlink' && options.target === undefined)
        throw new Error('missing symlink target');
      return addNode(parent, name, options.type, {
        ...(options.type === 'symlink' ? { target: options.target } : {}),
        refs: 1,
      });
    },
    link(inode, parent, name) {
      const node = get(inode);
      if (node.type === 'directory')
        throw Object.assign(new Error('directory link'), { code: 'EPERM' });
      const directory = get(parent);
      if (directory.children.has(name))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      directory.children.set(name, inode);
      node.nlink++;
    },
    unlink(parent, name) {
      const directory = get(parent);
      const inode = directory.children?.get(name);
      if (inode === undefined)
        throw Object.assign(new Error('missing entry'), { code: 'ENOENT' });
      directory.children.delete(name);
      const node = get(inode);
      node.nlink--;
      if (node.nlink === 0n && node.refs === 0) nodes.delete(inode);
    },
    rename(fromParent, fromName, toParent, toName) {
      const inode = storage.lookup(fromParent, fromName);
      const target = get(toParent);
      if (target.children.has(toName))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      target.children.set(toName, inode);
      get(fromParent).children.delete(fromName);
    },
  };
  return {
    storage,
    root: root.inode,
    inode: file.inode,
    retainCount(inode) {
      return nodes.get(inode)?.refs ?? 0;
    },
    has(inode) {
      return nodes.has(inode);
    },
    addDirectory(name, parent = root.inode) {
      return addNode(parent, name, 'directory');
    },
    addFile(name, contents, parent = root.inode) {
      const inode = addNode(parent, name, 'file', {
        data: encoder.encode(contents),
      });
      return inode;
    },
    addSymlink(name, target, parent = root.inode) {
      return addNode(parent, name, 'symlink', { target });
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

export function makeMount(store) {
  return {
    id: 0,
    path: '/',
    storage: store.storage,
    root: store.root,
    readOnly: false,
    device: 1n,
  };
}

export function openFile(table, store, options = {}) {
  store.storage.retain(store.inode);
  return table.allocate({
    kind: 'file',
    mount: makeMount(store),
    inode: store.inode,
    offset: 0n,
    rightsBase: ALL_RIGHTS,
    rightsInheriting: ALL_RIGHTS,
    flags: 0,
    ...options,
  });
}

export function makeCalls(
  table,
  guest = new WebAssembly.Memory({ initial: 1 })
) {
  const memory = new WasiMemory();
  memory.set(guest);
  return { guest, memory, calls: new WasiFdCalls(memory, table) };
}

export function readFd(
  calls,
  guest,
  fd,
  pointer,
  length,
  countPointer,
  tablePointer = 0
) {
  const view = new DataView(guest.buffer);
  view.setUint32(tablePointer, pointer, true);
  view.setUint32(tablePointer + 4, length, true);
  runSync(calls.imports.fd_read(fd, tablePointer, 1, countPointer));
  const count = view.getUint32(countPointer, true);
  return new Uint8Array(guest.buffer, pointer, count).slice();
}

export function writePath(memory, path, pointer = 256) {
  const bytes = encoder.encode(path);
  memory.range(pointer, bytes.byteLength).set(bytes);
  return { pointer, length: bytes.byteLength };
}
