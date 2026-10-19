// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface WasiPollResult {
  bytes: bigint;
  hangup?: boolean;
}

export interface WasiStdio {
  /** When flags contain NONBLOCK, these callbacks return a count or throw EAGAIN without starting async work. */
  readonly supportsNonblocking?: boolean;
  readInto?: (target: Uint8Array, flags: number) => number | Promise<number>;
  write?: (source: Uint8Array, flags: number) => number | Promise<number>;
  sync?: () => void | Promise<void>;
  /** Completes when ready; abort detaches a pending readiness subscription. */
  poll?: (
    direction: 'read' | 'write',
    signal: AbortSignal
  ) => WasiPollResult | Promise<WasiPollResult>;
}
