// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WASI, AsyncWASI } from 'node:wasi';
import { runWasiDescriptorTests } from 'test:wasi-descriptors';

export const wasi_preview1_descriptors_test = {
  async test() {
    await runWasiDescriptorTests(WASI, AsyncWASI);
  },
};
