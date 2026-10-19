// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const METHODS = [
  'lookup',
  'stat',
  'readlink',
  'readdir',
  'retain',
  'release',
  'readInto',
  'write',
  'append',
  'truncate',
  'setTimes',
  'sync',
  'create',
  'link',
  'unlink',
  'rename',
];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function checkName(name) {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    fail('EINVAL');
  }
}

export function createMemoryStorage(initialFiles = {}) {
  let nextInode = 2n;
  const nodes = new Map();
  const root = {
    inode: 1n,
    type: 'directory',
    children: new Map(),
    links: 1n,
    retains: 0,
    atimeNs: 1n,
    mtimeNs: 1n,
    ctimeNs: 1n,
  };
  nodes.set(root.inode, root);

  function get(inode) {
    const node = nodes.get(inode);
    if (node === undefined) fail('EBADF');
    return node;
  }

  function child(parent, name) {
    checkName(name);
    const directory = get(parent);
    if (directory.type !== 'directory') fail('ENOTDIR');
    const inode = directory.children.get(name);
    if (inode === undefined) fail('ENOENT');
    return get(inode);
  }

  function prune(node) {
    if (node.links === 0n && node.retains === 0) nodes.delete(node.inode);
  }

  function retain(inode) {
    get(inode).retains++;
  }

  function release(inode) {
    const node = get(inode);
    if (node.retains === 0) fail('EINVAL');
    node.retains--;
    prune(node);
  }

  function makeNode(type, values = {}) {
    const inode = nextInode++;
    const node = {
      inode,
      type,
      links: 1n,
      retains: 0,
      atimeNs: 1n,
      mtimeNs: 1n,
      ctimeNs: 1n,
      ...(type === 'directory' ? { children: new Map() } : {}),
      ...(type === 'file' ? { data: new Uint8Array() } : {}),
      ...values,
    };
    nodes.set(inode, node);
    return node;
  }

  const storage = {
    root: root.inode,

    lookup(parent, name) {
      return child(parent, name).inode;
    },

    stat(inode) {
      const node = get(inode);
      return {
        type: node.type,
        size: BigInt(node.data?.byteLength ?? 0),
        nlink: node.links,
        atimeNs: node.atimeNs,
        mtimeNs: node.mtimeNs,
        ctimeNs: node.ctimeNs,
      };
    },

    readlink(inode) {
      const node = get(inode);
      if (node.type !== 'symlink') fail('EINVAL');
      return node.target;
    },

    readdir(inode) {
      const directory = get(inode);
      if (directory.type !== 'directory') fail('ENOTDIR');
      return [...directory.children].map(([name, childInode]) => ({
        name,
        inode: childInode,
        type: get(childInode).type,
      }));
    },

    retain,
    release,

    readInto(inode, offset, target) {
      const node = get(inode);
      if (node.type !== 'file')
        fail(node.type === 'directory' ? 'EISDIR' : 'EINVAL');
      if (offset < 0n) fail('EINVAL');
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
        fail(node.type === 'directory' ? 'EISDIR' : 'EINVAL');
      if (offset < 0n) fail('EINVAL');
      const start = Number(offset);
      const end = start + source.byteLength;
      if (!Number.isSafeInteger(end)) fail('EFBIG');
      if (source.byteLength === 0) return 0;
      if (end > node.data.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(node.data);
        node.data = grown;
      }
      node.data.set(source, start);
      node.mtimeNs++;
      node.ctimeNs++;
      return source.byteLength;
    },

    append(inode, source) {
      const offset = BigInt(get(inode).data?.byteLength ?? 0);
      return { offset, bytesWritten: storage.write(inode, offset, source) };
    },

    truncate(inode, size) {
      const node = get(inode);
      if (node.type !== 'file')
        fail(node.type === 'directory' ? 'EISDIR' : 'EINVAL');
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) fail('EFBIG');
      const data = new Uint8Array(Number(size));
      data.set(node.data.subarray(0, data.byteLength));
      node.data = data;
      node.mtimeNs++;
      node.ctimeNs++;
    },

    setTimes(inode, times) {
      const node = get(inode);
      if (times.atimeNs !== undefined) node.atimeNs = times.atimeNs;
      if (times.mtimeNs !== undefined) node.mtimeNs = times.mtimeNs;
      node.ctimeNs++;
    },

    sync(inode, _dataOnly) {
      get(inode);
    },

    create(parent, name, options) {
      checkName(name);
      const directory = get(parent);
      if (directory.type !== 'directory') fail('ENOTDIR');
      const existing = directory.children.get(name);
      if (existing !== undefined) {
        if (options.exclusive) fail('EEXIST');
        const node = get(existing);
        if (node.type === 'directory') fail('EISDIR');
        if (node.type === 'symlink') fail('ELOOP');
        retain(node.inode);
        return node.inode;
      }
      if ((options.type === 'symlink') !== (options.target !== undefined))
        fail('EINVAL');
      const node = makeNode(
        options.type,
        options.type === 'symlink' ? { target: options.target } : {}
      );
      directory.children.set(name, node.inode);
      retain(node.inode);
      return node.inode;
    },

    link(inode, parent, name) {
      checkName(name);
      const node = get(inode);
      const directory = get(parent);
      if (directory.type !== 'directory') fail('ENOTDIR');
      if (node.type === 'directory') fail('EPERM');
      if (directory.children.has(name)) fail('EEXIST');
      directory.children.set(name, inode);
      node.links++;
    },

    unlink(parent, name, options) {
      checkName(name);
      const directory = get(parent);
      if (directory.type !== 'directory') fail('ENOTDIR');
      const node = child(parent, name);
      if (options.directory && node.type !== 'directory') fail('ENOTDIR');
      if (!options.directory && node.type === 'directory') fail('EISDIR');
      if (node.type === 'directory' && node.children.size > 0)
        fail('ENOTEMPTY');
      directory.children.delete(name);
      node.links--;
      prune(node);
    },

    rename(fromParent, fromName, toParent, toName) {
      checkName(fromName);
      checkName(toName);
      const from = get(fromParent);
      const to = get(toParent);
      if (from.type !== 'directory' || to.type !== 'directory') fail('ENOTDIR');
      const node = child(fromParent, fromName);
      const replacedInode = to.children.get(toName);
      if (replacedInode !== undefined) {
        const replaced = get(replacedInode);
        if (replaced.type === 'directory' && replaced.children.size > 0)
          fail('ENOTEMPTY');
        to.children.delete(toName);
        replaced.links--;
        prune(replaced);
      }
      from.children.delete(fromName);
      to.children.set(toName, node.inode);
    },
  };

  for (const [name, bytes] of Object.entries(initialFiles)) {
    checkName(name);
    const node = makeNode('file', { data: Uint8Array.from(bytes) });
    root.children.set(name, node.inode);
  }

  return {
    storage,
    inodeFor(name) {
      return child(root.inode, name).inode;
    },
    retainCount(inode) {
      return get(inode).retains;
    },
    readFile(name) {
      return child(root.inode, name).data.slice();
    },
  };
}

export function createAsyncStorage(storage, beforeOperation = async () => {}) {
  const result = { root: storage.root };
  for (const name of METHODS) {
    result[name] = async (...args) => {
      await beforeOperation(name, args);
      return storage[name](...args);
    };
  }
  return result;
}
