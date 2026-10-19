// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WASI } from 'node:wasi';
import { deepStrictEqual, strictEqual } from 'node:assert';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import module from './wasi-preview1-reactor.wasm';

export const nativePreopen = {
  test() {
    const root = '/tmp/wasi-preview1';
    mkdirSync(root);
    const seed = Uint8Array.of(83, 69, 69, 68, 58);
    const input = Uint8Array.of(0, 255, 65);
    writeFileSync(`${root}/note.bin`, seed);
    let consumed = false;
    const output = [];
    const host = new WASI({
      version: 'preview1',
      preopens: { '/data': root },
      stdio: [
        {
          readInto(target) {
            if (consumed) return 0;
            target.set(input);
            consumed = true;
            return input.length;
          },
        },
        { write: (bytes) => (output.push(...bytes), bytes.length) },
        { write: (bytes) => bytes.length },
      ],
    });
    const instance = new WebAssembly.Instance(module, host.getImportObject());
    try {
      host.initialize(instance);
      strictEqual(instance.exports.exchange(), 0);
      const expected = new Uint8Array([...seed, ...input]);
      deepStrictEqual(
        new Uint8Array(readFileSync(`${root}/note.bin`)),
        expected
      );
      deepStrictEqual(new Uint8Array(output), expected);

      const memory = instance.exports.memory;
      const view = new DataView(memory.buffer);
      const fd = view.getUint32(16, true);
      const readOpened = () => {
        view.setUint32(0, 1024, true);
        view.setUint32(4, 64, true);
        strictEqual(host.wasiImport.fd_pread(fd, 0, 1, 0n, 20), 0);
        return new Uint8Array(
          memory.buffer,
          1024,
          view.getUint32(20, true)
        ).slice();
      };

      // The open inode survives a native rename and replacement at its old path.
      renameSync(`${root}/note.bin`, `${root}/original.bin`);
      writeFileSync(`${root}/note.bin`, Uint8Array.of(99));
      deepStrictEqual(readOpened(), expected);
      linkSync(`${root}/original.bin`, `${root}/alias.bin`);
      unlinkSync(`${root}/original.bin`);
      deepStrictEqual(readOpened(), expected);
      unlinkSync(`${root}/alias.bin`);
      deepStrictEqual(readOpened(), expected);

      // A native backend reports its range limit; custom Storage keeps u64 data.
      strictEqual(host.wasiImport.fd_pread(fd, 0, 1, 1n << 32n, 20), 22);
      strictEqual(host.wasiImport.fd_close(fd), 0);
      strictEqual(host.wasiImport.fd_close(fd), 8);
    } finally {
      host.close();
      rmSync(root, { recursive: true });
    }
  },
};

export const nativePathOperations = {
  test() {
    const root = '/tmp/wasi-preview1-native-paths';
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    mkdirSync(`${root}/links`);
    mkdirSync(`${root}/source-dir`);
    mkdirSync(`${root}/replace-dir`);
    writeFileSync(`${root}/native-target.txt`, 'native target');
    writeFileSync(`${root}/links/target.txt`, 'relative target');
    symlinkSync(`${root}/native-target.txt`, `${root}/native-link`);

    const host = new WASI({ version: 'preview1', preopens: { '/data': root } });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    const decoder = new TextDecoder();
    let nextPath = 4096;
    const path = (value) => {
      const encoded = new TextEncoder().encode(value);
      const pointer = nextPath;
      nextPath += encoded.byteLength + 1;
      new Uint8Array(memory.buffer, pointer, encoded.byteLength).set(encoded);
      return { pointer, length: encoded.byteLength };
    };

    const open = (
      value,
      { follow = true, directory = false, rights = 2n } = {}
    ) => {
      const encoded = path(value);
      strictEqual(
        host.wasiImport.path_open(
          3,
          follow ? 1 : 0,
          encoded.pointer,
          encoded.length,
          directory ? 2 : 0,
          rights,
          directory ? (1n << 28n) - 1n : 0n,
          0,
          32
        ),
        0
      );
      return view.getUint32(32, true);
    };

    const readlink = (value) => {
      const encoded = path(value);
      strictEqual(
        host.wasiImport.path_readlink(
          3,
          encoded.pointer,
          encoded.length,
          256,
          1024,
          2048
        ),
        0
      );
      return decoder.decode(
        new Uint8Array(memory.buffer, 256, view.getUint32(2048, true))
      );
    };

    const createSymlink = (target, value) => {
      const encodedTarget = path(target);
      const encodedPath = path(value);
      strictEqual(
        host.wasiImport.path_symlink(
          encodedTarget.pointer,
          encodedTarget.length,
          3,
          encodedPath.pointer,
          encodedPath.length
        ),
        0
      );
    };

    const rename = (from, to) => {
      const encodedFrom = path(from);
      const encodedTo = path(to);
      strictEqual(
        host.wasiImport.path_rename(
          3,
          encodedFrom.pointer,
          encodedFrom.length,
          3,
          encodedTo.pointer,
          encodedTo.length
        ),
        0
      );
    };

    const readFile = (fd) => {
      view.setUint32(0, 512, true);
      view.setUint32(4, 128, true);
      strictEqual(host.wasiImport.fd_read(fd, 0, 1, 16), 0);
      return decoder.decode(
        new Uint8Array(memory.buffer, 512, view.getUint32(16, true))
      );
    };

    host.finalizeBindings({ exports: { memory } });
    try {
      const nativeLink = open('native-link');
      strictEqual(readFile(nativeLink), 'native target');
      strictEqual(host.wasiImport.fd_close(nativeLink), 0);

      createSymlink('target.txt', 'links/link.txt');
      strictEqual(readlink('links/link.txt'), 'target.txt');
      const linkBeforeMove = open('links/link.txt');
      strictEqual(readFile(linkBeforeMove), 'relative target');
      strictEqual(host.wasiImport.fd_close(linkBeforeMove), 0);

      rename('links', 'moved');
      strictEqual(readlink('moved/link.txt'), 'target.txt');
      const linkAfterMove = open('moved/link.txt');
      strictEqual(readFile(linkAfterMove), 'relative target');
      strictEqual(host.wasiImport.fd_close(linkAfterMove), 0);

      const retainedDirectory = open('replace-dir', {
        follow: false,
        directory: true,
        rights: (1n << 28n) - 1n,
      });
      rename('source-dir', 'replace-dir');

      strictEqual(
        host.wasiImport.fd_readdir(retainedDirectory, 256, 1024, 0n, 2048),
        0
      );
      const bytesUsed = view.getUint32(2048, true);
      const names = [];
      for (let offset = 0; offset < bytesUsed;) {
        const nameLength = view.getUint32(256 + offset + 16, true);
        names.push(
          decoder.decode(
            new Uint8Array(memory.buffer, 256 + offset + 24, nameLength)
          )
        );
        offset += 24 + nameLength;
      }
      deepStrictEqual(names, ['.', '..']);
      strictEqual(host.wasiImport.fd_close(retainedDirectory), 0);
    } finally {
      host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
};
