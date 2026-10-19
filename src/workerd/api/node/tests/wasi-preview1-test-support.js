// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import * as wasiModule from 'node:wasi';
import reactorModule from './wasi-preview1-reactor.wasm';

export function createStdio(inputBytes = new Uint8Array(), asyncWrite = false) {
  let inputOffset = 0;
  const output = [];
  const errors = [];
  return {
    stdio: [
      {
        readInto(target) {
          const count = Math.min(
            target.byteLength,
            inputBytes.byteLength - inputOffset
          );
          target.set(inputBytes.subarray(inputOffset, inputOffset + count));
          inputOffset += count;
          return count;
        },
      },
      {
        write(source) {
          const copy = source.slice();
          if (asyncWrite) {
            return Promise.resolve().then(() => {
              output.push(copy);
              return copy.byteLength;
            });
          }
          output.push(copy);
          return copy.byteLength;
        },
      },
      {
        write(source) {
          errors.push(source.slice());
          return source.byteLength;
        },
      },
    ],
    output() {
      return join(output);
    },
    errors() {
      return join(errors);
    },
  };
}

function join(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function readStrings(
  memory,
  countPointer,
  pointersPointer,
  maximumCount
) {
  const view = new DataView(memory.buffer);
  const count = view.getUint32(countPointer, true);
  if (count > maximumCount)
    throw new Error(`unexpected string count: ${count}`);
  const decoder = new TextDecoder();
  const result = [];
  for (let index = 0; index < count; index++) {
    const pointer = view.getUint32(pointersPointer + index * 4, true);
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (bytes[end] !== 0) end++;
    result.push(decoder.decode(bytes.subarray(pointer, end)));
  }
  return result;
}

export function readBytes(memory, pointer, length) {
  return new Uint8Array(memory.buffer, pointer, length).slice();
}

export function createReactor(
  storage,
  stdio,
  Host = wasiModule.WASI,
  options = {}
) {
  const host = new Host({
    version: 'preview1',
    args: ['guest', '--mode=test'],
    env: { MODE: 'test', OMIT: undefined },
    mounts: [{ path: '/data', storage }],
    stdio,
    ...options,
  });
  const instance = new WebAssembly.Instance(
    reactorModule,
    host.getImportObject()
  );
  return { host, instance };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
