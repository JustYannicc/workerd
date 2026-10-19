// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AsyncWASI, WASI } from 'node:wasi';
import { rejects, strictEqual, throws } from 'node:assert';
import { createReactor } from './wasi-preview1-test-support.js';

export async function testLifecycleErrors() {
  for (const Host of [WASI, AsyncWASI]) {
    const { host, instance } = createReactor(undefined, [{}, {}, {}], Host, {
      mounts: [],
    });
    try {
      if (Host === AsyncWASI) {
        await rejects(() => host.run(instance.exports.getArgs), {
          code: 'ERR_INVALID_STATE',
        });
      }
      await host.initialize(instance);
      await rejects(
        async () => host.initialize(instance),
        (error) => {
          strictEqual(error.code, 'ERR_WASI_ALREADY_STARTED');
          strictEqual(error.message, 'WASI instance has already started');
          strictEqual(
            error.toString(),
            'Error [ERR_WASI_ALREADY_STARTED]: WASI instance has already started'
          );
          return true;
        }
      );
      await host.close();
      await rejects(async () => host.initialize(instance), {
        code: 'ERR_INVALID_STATE',
      });
      if (Host === AsyncWASI) {
        await rejects(() => host.run(instance.exports.getArgs), {
          code: 'ERR_INVALID_STATE',
        });
      } else {
        throws(() => instance.exports.getArgs(), {
          code: 'ERR_INVALID_STATE',
        });
      }
    } finally {
      await host.close();
    }
  }
}
