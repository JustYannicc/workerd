// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AsyncWASI } from 'node:wasi';
import guestModule from './guest.wasm';
import { createDemoStorage } from './provider.js';

const SEED = Uint8Array.of(0x73, 0x65, 0x65, 0x64, 0x3a);
const REQUEST_BYTES = Uint8Array.of(0x00, 0xff, 0x41);
const MAX_INPUT_BYTES = 4096;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function bytesEqual(actual, expected) {
  if (actual.byteLength !== expected.byteLength) return false;
  return actual.every((byte, index) => byte === expected[index]);
}

function readStrings(memory, countPointer, pointersPointer) {
  const view = new DataView(memory.buffer);
  const count = view.getUint32(countPointer, true);
  const bytes = new Uint8Array(memory.buffer);
  const decoder = new TextDecoder();
  const strings = [];
  for (let index = 0; index < count; index++) {
    const pointer = view.getUint32(pointersPointer + index * 4, true);
    let end = pointer;
    while (bytes[end] !== 0) end++;
    strings.push(decoder.decode(bytes.subarray(pointer, end)));
  }
  return strings;
}

function join(chunks) {
  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function runWasiDemo(request) {
  const input = new Uint8Array(await request.arrayBuffer());
  if (input.byteLength > MAX_INPUT_BYTES) {
    return new Response('request body exceeds 4096 bytes', { status: 413 });
  }

  let inputOffset = 0;
  const output = [];
  const wasi = new AsyncWASI({
    version: 'preview1',
    args: ['wasi-preview1-demo', new URL(request.url).pathname],
    env: { WASI_DEMO: '1' },
    mounts: [{ path: '/data', storage: createDemoStorage() }],
    stdio: [
      {
        readInto(target) {
          const count = Math.min(target.byteLength, input.byteLength - inputOffset);
          target.set(input.subarray(inputOffset, inputOffset + count));
          inputOffset += count;
          return count;
        },
      },
      {
        write(source) {
          output.push(source.slice());
          return source.byteLength;
        },
      },
      { write: (source) => source.byteLength },
    ],
  });

  try {
    const instance = await WebAssembly.instantiate(guestModule, wasi.getImportObject());
    await wasi.initialize(instance);
    check((await wasi.run(instance.exports.getArgs)) === 0, 'WASI args_get failed');
    check((await wasi.run(instance.exports.getEnv)) === 0, 'WASI environ_get failed');
    const args = readStrings(instance.exports.memory, 64, 72);
    const env = readStrings(instance.exports.memory, 80, 88);
    check((await wasi.run(instance.exports.exchange)) === 0, 'WASI file exchange failed');
    return new Response(join(output), {
      headers: {
        'content-type': 'application/octet-stream',
        'x-wasi-args': JSON.stringify(args),
        'x-wasi-env': JSON.stringify(env),
      },
    });
  } finally {
    await wasi.close();
  }
}

export default { fetch: runWasiDemo };

export const test = {
  async test() {
    const response = await runWasiDemo(
      new Request('http://example.test/demo', {
        method: 'POST',
        body: REQUEST_BYTES,
      })
    );
    check(response.status === 200, 'unexpected response status');
    check(
      response.headers.get('x-wasi-args') === '["wasi-preview1-demo","/demo"]',
      'guest arguments do not match'
    );
    check(response.headers.get('x-wasi-env') === '["WASI_DEMO=1"]', 'guest environment does not match');
    const actual = new Uint8Array(await response.arrayBuffer());
    const expected = new Uint8Array([...SEED, ...REQUEST_BYTES]);
    check(bytesEqual(actual, expected), 'guest stdout does not match the stored bytes');
  },
};
