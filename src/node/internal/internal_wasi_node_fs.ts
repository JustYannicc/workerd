// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { default as cffs } from 'cloudflare-internal:filesystem';
import { normalizePath } from 'node-internal:internal_fs_utils';
import type {
  CreateOptions,
  DirectoryEntry,
  Inode,
  Stat,
  Storage,
  Times,
} from './internal_wasi_storage';

const MAX_NATIVE_VALUE = 0xffff_ffffn;

type NodeType = Stat['type'];
type NativeFdHandle = ReturnType<typeof cffs.getFdHandle>;

interface NativeNode {
  inode: Inode;
  uuid: string;
  type: NodeType;
  paths: Set<string>;
  retains: number;
  fd: number | undefined;
  fdHandle: NativeFdHandle | undefined;
  fdWritable: boolean;
  symlinkTarget: string | undefined;
  unlinkedEmpty: boolean;
}

type CodedError = Error & { code: string };

function fail(code: string): never {
  const error = new Error(code) as CodedError;
  error.code = code;
  throw error;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function checkedName(name: string): void {
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

function nativeRootUrl(rootPath: string): URL {
  const url = rootPath.startsWith('file:')
    ? new URL(rootPath)
    : normalizePath(rootPath);
  if (
    url.protocol !== 'file:' ||
    url.hostname !== '' ||
    url.search ||
    url.hash
  ) {
    fail('EINVAL');
  }
  return url;
}

function childUrl(parent: URL, name: string): URL {
  const base = new URL(parent.href);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  try {
    return new URL(encodeURIComponent(name), base);
  } catch {
    return fail('EINVAL');
  }
}

function fileType(type: string): NodeType {
  if (type === 'file' || type === 'directory' || type === 'symlink')
    return type;
  return fail('ENOTSUP');
}

/**
 * Storage over workerd's in-memory VFS. Metadata follows the existing Node fs
 * policy: atime is zero, ctime mirrors mtime, and nlink is one. VFS mtime is
 * nanosecond-valued, but setTimes receives a Date and therefore has millisecond
 * precision. Nonzero atime requests return ENOTSUP; VFS mtime updates on
 * directories and symlinks remain no-ops. The VFS applies operations
 * synchronously; sync validates the inode but does not promise persistence
 * across worker lifetimes.
 */
export class NodeStorage implements Storage {
  readonly root: Inode;

  // Keep UUID mappings while a node has an alias or retain. Inode numbers stay
  // monotonic after an entry is evicted.
  #nodes = new Map<Inode, NativeNode>();
  #inodesByUuid = new Map<string, Inode>();
  #nextInode = 1n;
  #rootUrl: URL;

  constructor(rootPath: string) {
    const rootUrl = nativeRootUrl(rootPath);
    const rootStat = cffs.stat(rootUrl, { followSymlinks: false });
    if (rootStat === null) fail('ENOENT');
    if (rootStat.type !== 'directory') fail('ENOTDIR');
    this.#rootUrl = new URL(rootUrl.href);
    this.root = this.#remember(rootUrl, rootStat).inode;
  }

  lookup(parent: Inode, name: string): Inode {
    checkedName(name);
    const parentNode = this.#node(parent);
    if (parentNode.type !== 'directory') fail('ENOTDIR');
    if (parentNode.unlinkedEmpty) fail('ENOENT');
    const path = childUrl(new URL(this.#path(parentNode)), name);
    const info = cffs.stat(path, { followSymlinks: false });
    if (info === null) fail('ENOENT');
    return this.#remember(path, info).inode;
  }

  stat(inode: Inode): Stat {
    const node = this.#node(inode);
    const info = this.#statNode(node);
    if (info.device) fail('ENOTSUP');
    return {
      type: node.type,
      size: BigInt(info.size),
      nlink: 1n,
      atimeNs: 0n,
      mtimeNs: info.lastModified,
      ctimeNs: info.lastModified,
    };
  }

  readlink(inode: Inode): string {
    const node = this.#node(inode);
    if (node.type !== 'symlink') fail('EINVAL');
    if (node.fd === undefined) this.#path(node);
    if (node.symlinkTarget === undefined) {
      node.symlinkTarget = this.#readNativeLink(new URL(this.#path(node)));
    }
    return node.symlinkTarget;
  }

  readdir(inode: Inode): DirectoryEntry[] {
    const node = this.#node(inode);
    if (node.type !== 'directory') fail('ENOTDIR');
    if (node.unlinkedEmpty && node.fd !== undefined) return [];
    const path = new URL(this.#path(node));
    return cffs.readdir(path, { recursive: false }).map((entry) => {
      const child = this.lookup(inode, entry.name);
      return { name: entry.name, inode: child, type: this.#node(child).type };
    });
  }

  retain(inode: Inode): void {
    const node = this.#node(inode);
    if (node.fd !== undefined) {
      node.retains++;
      return;
    }

    const path = new URL(this.#path(node));
    const info = cffs.stat(path, { followSymlinks: false });
    if (info === null) fail('ENOENT');
    const fd = cffs.open(path, {
      read: true,
      write: node.type === 'file' && info.writable,
      append: false,
      create: false,
      exclusive: false,
      truncate: false,
      followSymlinks: false,
    });
    const handle = cffs.getFdHandle(fd);
    try {
      this.#verifyFd(node, fd);
    } catch (error) {
      handle.close();
      throw error;
    }
    node.fd = fd;
    node.fdHandle = handle;
    node.fdWritable = node.type === 'file' && info.writable;
    node.retains = 1;
  }

  release(inode: Inode): void {
    const node = this.#node(inode);
    if (node.retains === 0) fail('EINVAL');
    node.retains--;
    if (node.retains > 0) return;
    node.fdHandle?.close();
    node.fdHandle = undefined;
    node.fd = undefined;
    node.fdWritable = false;
    this.#prune(node);
  }

  readInto(inode: Inode, offset: bigint, target: Uint8Array): number {
    this.#checkOffset(offset);
    return this.#withFd(this.#node(inode), false, (fd) =>
      cffs.read(fd, [target], { position: offset })
    );
  }

  write(inode: Inode, offset: bigint, source: Uint8Array): number {
    this.#checkRange(offset, source.byteLength);
    return this.#withFd(this.#node(inode), true, (fd) =>
      source.byteLength === 0
        ? 0
        : cffs.write(fd, [source], { position: offset })
    );
  }

  append(
    inode: Inode,
    source: Uint8Array
  ): { offset: bigint; bytesWritten: number } {
    const node = this.#node(inode);
    return this.#withFd(node, true, (fd) => {
      const appended = cffs.append(fd, source);
      return {
        offset: BigInt(appended.offset),
        bytesWritten: appended.bytesWritten,
      };
    });
  }

  truncate(inode: Inode, size: bigint): void {
    this.#checkOffset(size);
    this.#withFd(this.#node(inode), true, (fd) => {
      cffs.truncate(fd, Number(size));
    });
  }

  setTimes(inode: Inode, times: Times): void {
    const node = this.#node(inode);
    if (times.atimeNs !== undefined && times.atimeNs !== 0n) fail('ENOTSUP');
    if (times.mtimeNs === undefined) return;
    if (node.type !== 'file') {
      this.#statNode(node);
      return;
    }
    const milliseconds = times.mtimeNs / 1_000_000n;
    const numericTime = Number(milliseconds);
    const date = new Date(numericTime);
    if (!Number.isFinite(numericTime) || Number.isNaN(date.getTime()))
      fail('EINVAL');
    this.#withFd(node, true, (fd) => {
      cffs.setLastModified(fd, date, { followSymlinks: false });
    });
  }

  sync(inode: Inode, _dataOnly: boolean): void {
    this.#statNode(this.#node(inode));
  }

  create(parent: Inode, name: string, options: CreateOptions): Inode {
    checkedName(name);
    if ((options.type === 'symlink') !== (options.target !== undefined))
      fail('EINVAL');
    if (
      options.target !== undefined &&
      (options.target.length === 0 || options.target.includes('\0'))
    ) {
      fail('EINVAL');
    }
    const parentNode = this.#node(parent);
    if (parentNode.type !== 'directory') fail('ENOTDIR');
    const path = childUrl(new URL(this.#path(parentNode)), name);
    const existing = cffs.stat(path, { followSymlinks: false });

    if (existing !== null) {
      if (options.exclusive) fail('EEXIST');
      if (options.type === 'file') {
        if (existing.type === 'directory') fail('EISDIR');
        if (existing.type === 'symlink') fail('ELOOP');
        const node = this.#remember(path, existing);
        this.retain(node.inode);
        return node.inode;
      }
      if (existing.type === 'directory') fail('EISDIR');
      if (existing.type === 'symlink') fail('ELOOP');
      fail('EEXIST');
    }

    if (options.type === 'file') {
      let fd: number;
      try {
        fd = cffs.open(path, {
          read: true,
          write: true,
          append: false,
          create: true,
          exclusive: true,
          truncate: false,
          followSymlinks: false,
        });
      } catch (error) {
        if (options.exclusive || errorCode(error) !== 'EEXIST') throw error;
        const raced = cffs.stat(path, { followSymlinks: false });
        if (raced === null) throw error;
        if (raced.type === 'directory') fail('EISDIR');
        if (raced.type === 'symlink') fail('ELOOP');
        const node = this.#remember(path, raced);
        this.retain(node.inode);
        return node.inode;
      }
      const handle = cffs.getFdHandle(fd);
      let createdUuid: string | undefined;
      let node: NativeNode | undefined;
      try {
        createdUuid = cffs.getUniqueId(fd, { followSymlinks: false });
        const info = this.#nativeStat(fd);
        if (cffs.getUniqueId(path, { followSymlinks: false }) !== createdUuid) {
          fail('ESTALE');
        }
        node = this.#remember(path, info);
        if (node.uuid !== createdUuid) fail('ESTALE');
        node.fd = fd;
        node.fdHandle = handle;
        node.fdWritable = true;
        node.retains = 1;
        return node.inode;
      } catch (error) {
        let ownsPath = false;
        if (createdUuid !== undefined) {
          try {
            ownsPath =
              cffs.getUniqueId(path, { followSymlinks: false }) === createdUuid;
          } catch {
            // The path may have disappeared while creation was being reported.
          }
        }
        handle.close();
        if (ownsPath) {
          try {
            cffs.unlink(path);
          } catch {
            // Preserve the creation error if rollback is no longer possible.
          }
        }
        if (node !== undefined) {
          this.#removePath(node, path.href);
        }
        throw error;
      }
    }

    if (options.type === 'directory') {
      cffs.mkdir(path, { recursive: false, tmp: false });
    } else {
      if (options.target === undefined) fail('EINVAL');
      cffs.link(path, this.#linkTarget(options.target, path), {
        symbolic: true,
      });
    }
    let createdUuid: string | undefined;
    let node: NativeNode | undefined;
    try {
      createdUuid = cffs.getUniqueId(path, { followSymlinks: false });
      const info = cffs.stat(path, { followSymlinks: false });
      if (info === null) fail('EIO');
      node = this.#remember(path, info, options.target);
      if (node.uuid !== createdUuid) fail('ESTALE');
      if (node.type === 'symlink') node.symlinkTarget = options.target;
      this.retain(node.inode);
      return node.inode;
    } catch (error) {
      if (createdUuid !== undefined) {
        try {
          if (
            cffs.getUniqueId(path, { followSymlinks: false }) === createdUuid
          ) {
            if (options.type === 'directory') {
              cffs.rm(path, { recursive: false, force: true, dironly: true });
            } else {
              cffs.unlink(path);
            }
          }
        } catch {
          // Preserve the creation error if rollback is no longer possible.
        }
      }
      if (node !== undefined) {
        this.#removePath(node, path.href);
      }
      throw error;
    }
  }

  link(inode: Inode, parent: Inode, name: string): void {
    checkedName(name);
    const node = this.#node(inode);
    if (node.type === 'directory') fail('EPERM');
    if (node.paths.size === 0) fail('ENOENT');
    const parentNode = this.#node(parent);
    if (parentNode.type !== 'directory') fail('ENOTDIR');
    const source = new URL(this.#path(node));
    const destination = childUrl(new URL(this.#path(parentNode)), name);
    cffs.link(destination, source, { symbolic: false });
    node.paths.add(destination.href);
  }

  unlink(parent: Inode, name: string, options: { directory: boolean }): void {
    checkedName(name);
    const parentNode = this.#node(parent);
    if (parentNode.type !== 'directory') fail('ENOTDIR');
    const path = childUrl(new URL(this.#path(parentNode)), name);
    const child = this.#node(this.lookup(parent, name));
    if (options.directory && child.type !== 'directory') fail('ENOTDIR');
    if (!options.directory && child.type === 'directory') fail('EISDIR');
    if (options.directory) {
      cffs.rm(path, { recursive: false, force: false, dironly: true });
    } else {
      cffs.unlink(path);
    }
    this.#removePath(child, path.href);
    if (options.directory && child.retains > 0) child.unlinkedEmpty = true;
  }

  rename(
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string
  ): void {
    checkedName(fromName);
    checkedName(toName);
    const source = this.#node(this.lookup(fromParent, fromName));
    const fromParentNode = this.#node(fromParent);
    const toParentNode = this.#node(toParent);
    if (
      fromParentNode.type !== 'directory' ||
      toParentNode.type !== 'directory'
    ) {
      fail('ENOTDIR');
    }
    const fromPath = childUrl(new URL(this.#path(fromParentNode)), fromName);
    const toPath = childUrl(new URL(this.#path(toParentNode)), toName);
    const existing = cffs.stat(toPath, { followSymlinks: false });
    let replaced: NativeNode | undefined;
    if (existing !== null) {
      replaced = this.#remember(toPath, existing);
      if (replaced.uuid === source.uuid) return;
    }

    cffs.renameOrCopy(fromPath, toPath, { copy: false });
    if (cffs.getUniqueId(toPath, { followSymlinks: false }) !== source.uuid) {
      fail('ESTALE');
    }
    if (replaced !== undefined) {
      this.#removePath(replaced, toPath.href);
      if (replaced.type === 'directory' && replaced.retains > 0) {
        replaced.unlinkedEmpty = true;
      }
    }
    this.#movePaths(fromPath, toPath);
  }

  #node(inode: Inode): NativeNode {
    const node = this.#nodes.get(inode);
    if (node === undefined) fail('ENOENT');
    return node;
  }

  #remember(path: URL, info: cffs.Stat, symlinkTarget?: string): NativeNode {
    if (info.device) fail('ENOTSUP');
    const uuid = cffs.getUniqueId(path, { followSymlinks: false });
    const existingInode = this.#inodesByUuid.get(uuid);
    if (existingInode !== undefined) {
      const existing = this.#node(existingInode);
      if (existing.type !== fileType(info.type)) fail('ESTALE');
      existing.paths.add(path.href);
      return existing;
    }
    const node: NativeNode = {
      inode: this.#nextInode++,
      uuid,
      type: fileType(info.type),
      paths: new Set([path.href]),
      retains: 0,
      fd: undefined,
      fdHandle: undefined,
      fdWritable: false,
      symlinkTarget: undefined,
      unlinkedEmpty: false,
    };
    if (node.type === 'symlink') {
      node.symlinkTarget = symlinkTarget ?? this.#readNativeLink(path);
    }
    this.#nodes.set(node.inode, node);
    this.#inodesByUuid.set(uuid, node.inode);
    return node;
  }

  #path(node: NativeNode): string {
    for (const path of node.paths) {
      try {
        if (
          cffs.getUniqueId(new URL(path), { followSymlinks: false }) ===
          node.uuid
        ) {
          return path;
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') {
          throw error;
        }
      }
      this.#removePath(node, path);
    }
    fail(node.retains > 0 ? 'ESTALE' : 'ENOENT');
  }

  #nativeStat(pathOrFd: number | URL): cffs.Stat {
    const info = cffs.stat(pathOrFd, { followSymlinks: false });
    if (info === null) fail('ENOENT');
    return info;
  }

  #statNode(node: NativeNode): cffs.Stat {
    if (node.fd !== undefined) {
      const info = this.#nativeStat(node.fd);
      this.#verifyFd(node, node.fd);
      return info;
    }
    return this.#nativeStat(new URL(this.#path(node)));
  }

  #verifyFd(node: NativeNode, fd: number): void {
    if (cffs.getUniqueId(fd, { followSymlinks: false }) !== node.uuid)
      fail('ESTALE');
  }

  #withFd<T>(node: NativeNode, write: boolean, fn: (fd: number) => T): T {
    if (node.type !== 'file') {
      fail(node.type === 'directory' ? 'EISDIR' : 'EINVAL');
    }
    if (node.fd !== undefined) {
      this.#verifyFd(node, node.fd);
      if (!write || node.fdWritable) return fn(node.fd);
      if (!this.#nativeStat(node.fd).writable) fail('EPERM');
    }
    const path = new URL(this.#path(node));
    const info = cffs.stat(path, { followSymlinks: false });
    if (info === null) fail('ENOENT');
    if (write && !info.writable) fail('EPERM');
    const fd = cffs.open(path, {
      read: true,
      write,
      append: false,
      create: false,
      exclusive: false,
      truncate: false,
      followSymlinks: false,
    });
    const handle = cffs.getFdHandle(fd);
    try {
      this.#verifyFd(node, fd);
      return fn(fd);
    } finally {
      handle.close();
    }
  }

  #checkOffset(offset: bigint): void {
    if (offset < 0n) fail('EINVAL');
    if (offset > MAX_NATIVE_VALUE) fail('EFBIG');
  }

  #checkRange(offset: bigint, size: number): void {
    this.#checkOffset(offset);
    if (offset + BigInt(size) > MAX_NATIVE_VALUE) fail('EFBIG');
  }

  #movePaths(from: URL, to: URL): void {
    const sourcePath = from.pathname;
    const destinationPath = to.pathname;
    const prefix = sourcePath.endsWith('/') ? sourcePath : `${sourcePath}/`;
    for (const node of this.#nodes.values()) {
      for (const path of [...node.paths]) {
        const pathname = new URL(path).pathname;
        if (pathname !== sourcePath && !pathname.startsWith(prefix)) continue;
        const suffix = pathname.slice(sourcePath.length);
        const moved = new URL(path);
        moved.pathname = `${destinationPath}${suffix}`;
        node.paths.delete(path);
        node.paths.add(moved.href);
      }
    }
  }

  #readNativeLink(path: URL): string {
    const target = cffs.readLink(path, { failIfNotSymlink: true });
    const root = this.#rootUrl.pathname.replace(/\/+$/, '');
    if (target === root) return '/';
    if (target.startsWith(`${root}/`)) return target.slice(root.length);
    fail('ENOTCAPABLE');
  }

  #linkTarget(target: string, linkPath: URL): URL {
    // The VFS stores symlink targets as paths rooted at the worker VFS. Keep
    // the guest's original text separately so WASI resolves relative links
    // from the link's current parent after a rename.
    const absolute = target.startsWith('/');
    const base = absolute
      ? new URL(this.#rootUrl.href)
      : new URL(linkPath.href);
    if (absolute) {
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
    } else {
      base.pathname = base.pathname.slice(
        0,
        base.pathname.lastIndexOf('/') + 1
      );
    }
    const path = absolute ? target.replace(/^\/+/, '') : target;
    const encodedPath = path
      .split('/')
      .map((part) =>
        part === '' || part === '.' || part === '..'
          ? part
          : encodeURIComponent(part)
      )
      .join('/');
    try {
      return new URL(encodedPath, base);
    } catch {
      return fail('EINVAL');
    }
  }

  #removePath(node: NativeNode, path: string): void {
    node.paths.delete(path);
    this.#prune(node);
  }

  #prune(node: NativeNode): void {
    if (node.inode === this.root || node.paths.size > 0 || node.retains > 0) {
      return;
    }
    this.#nodes.delete(node.inode);
    if (this.#inodesByUuid.get(node.uuid) === node.inode) {
      this.#inodesByUuid.delete(node.uuid);
    }
  }
}
