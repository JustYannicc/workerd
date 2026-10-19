// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const ROOT = 1n;
const NOTE = 2n;
const seed = Uint8Array.of(0x73, 0x65, 0x65, 0x64, 0x3a);

function error(code) {
  const result = new Error(code);
  result.code = code;
  return result;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

export function createDemoStorage() {
  let bytes = seed.slice();
  let retains = new Map([[ROOT, 0], [NOTE, 0]]);

  function requireInode(inode) {
    if (inode !== ROOT && inode !== NOTE) throw error('EBADF');
  }

  return {
    root: ROOT,

    async lookup(parent, name) {
      if (parent !== ROOT) throw error('ENOTDIR');
      if (name !== 'note.bin') throw error('ENOENT');
      return NOTE;
    },

    async stat(inode) {
      requireInode(inode);
      return inode === ROOT
        ? { type: 'directory', size: 0n, nlink: 1n, atimeNs: 0n, mtimeNs: 0n, ctimeNs: 0n }
        : {
            type: 'file',
            size: BigInt(bytes.byteLength),
            nlink: 1n,
            atimeNs: 0n,
            mtimeNs: 1n,
            ctimeNs: 1n,
          };
    },

    async readlink() {
      throw error('EINVAL');
    },

    async readdir(inode) {
      if (inode !== ROOT) throw error('ENOTDIR');
      return [{ name: 'note.bin', inode: NOTE, type: 'file' }];
    },

    async retain(inode) {
      requireInode(inode);
      retains.set(inode, retains.get(inode) + 1);
    },

    async release(inode) {
      requireInode(inode);
      if (retains.get(inode) === 0) throw error('EINVAL');
      retains.set(inode, retains.get(inode) - 1);
    },

    async readInto(inode, offset, target) {
      await pause();
      if (inode !== NOTE) throw error('EISDIR');
      if (offset < 0n) throw error('EINVAL');
      const start = Number(offset);
      const count = Math.max(0, Math.min(target.byteLength, bytes.byteLength - start));
      if (count > 0) target.set(bytes.subarray(start, start + count));
      return count;
    },

    async write(inode, offset, source) {
      await pause();
      if (inode !== NOTE) throw error('EISDIR');
      if (offset < 0n) throw error('EINVAL');
      const start = Number(offset);
      const end = start + source.byteLength;
      const next = new Uint8Array(Math.max(bytes.byteLength, end));
      next.set(bytes);
      next.set(source, start);
      bytes = next;
      return source.byteLength;
    },

    async append(inode, source) {
      await pause();
      if (inode !== NOTE) throw error('EISDIR');
      const offset = BigInt(bytes.byteLength);
      const next = new Uint8Array(bytes.byteLength + source.byteLength);
      next.set(bytes);
      next.set(source, bytes.byteLength);
      bytes = next;
      return { offset, bytesWritten: source.byteLength };
    },

    async truncate(inode, size) {
      if (inode !== NOTE) throw error('EISDIR');
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw error('EFBIG');
      const next = new Uint8Array(Number(size));
      next.set(bytes.subarray(0, next.byteLength));
      bytes = next;
    },

    async setTimes(inode) {
      requireInode(inode);
    },

    async sync(inode) {
      requireInode(inode);
    },

    async create() {
      throw error('ENOTSUP');
    },

    async link() {
      throw error('ENOTSUP');
    },

    async unlink() {
      throw error('ENOTSUP');
    },

    async rename() {
      throw error('ENOTSUP');
    },
  };
}
