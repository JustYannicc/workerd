// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  deepStrictEqual,
  rejects,
  strictEqual,
} from 'node-internal:internal_assert';
import { WasiHost } from 'node-internal:internal_wasi_host';
import { runAsync, runSync } from 'node-internal:internal_wasi_calls';
import {
  WasiDescriptorTable,
  RIGHTS,
} from 'node-internal:internal_wasi_descriptors';
import { WasiMemory } from 'node-internal:internal_wasi_memory';
import { makeStore, openFile } from 'test:wasi-descriptors-support';

const SUCCESS = 0;
const EBADF = 8;
const ENOTCAPABLE = 76;
const ENOTSUP = 58;
const EPIPE = 64;
const CLOCK_MONOTONIC = 1;
const EVENT_CLOCK = 0;
const EVENT_FD_READ = 1;
const EVENT_FD_WRITE = 2;
const EVENT_HANGUP = 1;
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;
const SUBSCRIPTIONS = 0;
const EVENTS = 4096;
const EVENT_COUNT = 8192;

function makeHost(table, asyncMode) {
  const guest = new WebAssembly.Memory({ initial: 1 });
  const memory = new WasiMemory();
  memory.set(guest);
  return { guest, host: new WasiHost(memory, [], [], asyncMode, table) };
}

function encodeSubscriptions(guest, subscriptions) {
  const bytes = new Uint8Array(
    guest.buffer,
    SUBSCRIPTIONS,
    subscriptions.length * SUBSCRIPTION_SIZE
  );
  bytes.fill(0);
  const view = new DataView(guest.buffer);
  for (const [index, subscription] of subscriptions.entries()) {
    const offset = SUBSCRIPTIONS + index * SUBSCRIPTION_SIZE;
    view.setBigUint64(offset, subscription.userdata, true);
    view.setUint8(offset + 8, subscription.type);
    if (subscription.type === EVENT_CLOCK) {
      view.setUint32(offset + 16, subscription.clockId, true);
      view.setBigUint64(offset + 24, subscription.timeout, true);
      view.setBigUint64(offset + 32, subscription.precision ?? 0n, true);
      view.setUint16(offset + 40, subscription.flags ?? 0, true);
    } else {
      view.setUint32(offset + 16, subscription.fd, true);
    }
  }
}

function readEvents(guest) {
  const view = new DataView(guest.buffer);
  const count = view.getUint32(EVENT_COUNT, true);
  return Array.from({ length: count }, (_, index) => {
    const offset = EVENTS + index * EVENT_SIZE;
    return {
      userdata: view.getBigUint64(offset, true),
      errno: view.getUint16(offset + 8, true),
      type: view.getUint8(offset + 10),
      bytes: view.getBigUint64(offset + 16, true),
      flags: view.getUint16(offset + 24, true),
    };
  });
}

function runPollSync(host, guest, subscriptions) {
  encodeSubscriptions(guest, subscriptions);
  strictEqual(
    runSync(
      host.imports.poll_oneoff(
        SUBSCRIPTIONS,
        EVENTS,
        subscriptions.length,
        EVENT_COUNT
      )
    ),
    SUCCESS
  );
  return readEvents(guest);
}

async function runPollAsync(host, guest, subscriptions, timeoutMs = 1000) {
  encodeSubscriptions(guest, subscriptions);
  const result = await withDeadline(
    runAsync(
      host.imports.poll_oneoff(
        SUBSCRIPTIONS,
        EVENTS,
        subscriptions.length,
        EVENT_COUNT
      )
    ),
    'poll_oneoff did not complete',
    timeoutMs
  );
  strictEqual(result, SUCCESS);
  return readEvents(guest);
}

function fd(userdata, type, descriptor) {
  return { userdata: BigInt(userdata), type, fd: descriptor };
}

function clock(userdata, timeout) {
  return {
    userdata: BigInt(userdata),
    type: EVENT_CLOCK,
    clockId: CLOCK_MONOTONIC,
    timeout,
    precision: 0n,
    flags: 0,
  };
}

function event(events, userdata) {
  const found = events.find((item) => item.userdata === BigInt(userdata));
  if (found === undefined) throw new Error(`Missing poll event ${userdata}`);
  return found;
}

function assertPollEvent(events, userdata, errno, type, bytes = 0n, flags = 0) {
  deepStrictEqual(event(events, userdata), {
    userdata: BigInt(userdata),
    errno,
    type,
    bytes,
    flags,
  });
}

async function withDeadline(promise, message, timeoutMs = 1000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function testRegularFilesAndFdErrors() {
  const table = new WasiDescriptorTable();
  const store = makeStore('abcdef');
  const file = openFile(table, store);
  table.get(file).offset = 2n;
  const { guest, host } = makeHost(table, false);
  const events = runPollSync(host, guest, [
    fd(11, EVENT_FD_READ, file),
    fd(12, EVENT_FD_WRITE, file),
    fd(13, EVENT_FD_READ, 999),
  ]);
  strictEqual(events.length, 3);
  assertPollEvent(events, 11, SUCCESS, EVENT_FD_READ, 4n);
  assertPollEvent(events, 12, SUCCESS, EVENT_FD_WRITE);
  assertPollEvent(events, 13, EBADF, EVENT_FD_READ);
  strictEqual(table.get(file).offset, 2n);
  runSync(table.closeAll());
}

function testPollRightsArePerSubscription() {
  const table = new WasiDescriptorTable();
  const store = makeStore();
  const noPoll = openFile(table, store, {
    rightsBase: RIGHTS.FD_READ | RIGHTS.FD_WRITE,
  });
  const noRead = openFile(table, store, {
    rightsBase: RIGHTS.POLL_FD_READWRITE,
  });
  const noWrite = openFile(table, store, {
    rightsBase: RIGHTS.POLL_FD_READWRITE | RIGHTS.FD_READ,
  });
  const { guest, host } = makeHost(table, false);
  const events = runPollSync(host, guest, [
    fd(21, EVENT_FD_READ, noPoll),
    fd(22, EVENT_FD_READ, noRead),
    fd(23, EVENT_FD_WRITE, noWrite),
  ]);
  strictEqual(events.length, 3);
  for (const userdata of [21, 22, 23]) {
    strictEqual(event(events, userdata).errno, ENOTCAPABLE);
  }
  runSync(table.closeAll());
}

async function testStdioReadinessAndHangup() {
  const table = new WasiDescriptorTable();
  let streamClosed = 0;
  const descriptor = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ | RIGHTS.POLL_FD_READWRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      poll: async () => ({ bytes: 7n, hangup: true }),
      close() {
        streamClosed++;
      },
    },
  });
  const { guest, host } = makeHost(table, true);
  const events = await runPollAsync(host, guest, [
    fd(31, EVENT_FD_READ, descriptor),
  ]);
  assertPollEvent(events, 31, SUCCESS, EVENT_FD_READ, 7n, EVENT_HANGUP);
  runSync(table.close(descriptor));
  strictEqual(streamClosed, 0);
}

async function testClockWinsAndAbortsBlockedStdio() {
  const table = new WasiDescriptorTable();
  let reportStarted;
  let sawAbort = false;
  let streamClosed = 0;
  const started = new Promise((resolve) => {
    reportStarted = resolve;
  });
  const descriptor = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ | RIGHTS.POLL_FD_READWRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      poll(_direction, signal) {
        reportStarted();
        return new Promise((resolve) => {
          const onAbort = () => {
            sawAbort = true;
            resolve({ bytes: 0n });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      close() {
        streamClosed++;
      },
    },
  });
  const { guest, host } = makeHost(table, true);
  const pending = runPollAsync(host, guest, [
    fd(41, EVENT_FD_READ, descriptor),
    clock(42, 20_000_000n),
  ]);
  await withDeadline(started, 'stdio readiness was never subscribed');
  const events = await pending;
  strictEqual(events.length, 1);
  assertPollEvent(events, 42, SUCCESS, EVENT_CLOCK);
  strictEqual(sawAbort, true);
  runSync(table.close(descriptor));
  strictEqual(streamClosed, 0);
}

async function testReadyFileBeatsFutureClock() {
  const table = new WasiDescriptorTable();
  const store = makeStore('ready');
  const file = openFile(table, store);
  const { guest, host } = makeHost(table, true);
  const events = await runPollAsync(
    host,
    guest,
    [fd(51, EVENT_FD_READ, file), clock(52, 250_000_000n)],
    500
  );
  strictEqual(events.length, 1);
  assertPollEvent(events, 51, SUCCESS, EVENT_FD_READ, 5n);
  runSync(table.closeAll());
}

async function testProviderErrors() {
  const table = new WasiDescriptorTable();
  const store = makeStore();
  const file = openFile(table, store);
  const providerError = new Error('provider exploded');
  store.storage.stat = () => {
    throw providerError;
  };
  const { guest, host } = makeHost(table, true);
  encodeSubscriptions(guest, [fd(61, EVENT_FD_READ, file)]);
  await rejects(
    withDeadline(
      runAsync(host.imports.poll_oneoff(SUBSCRIPTIONS, EVENTS, 1, EVENT_COUNT)),
      'unknown provider failure was swallowed'
    ),
    (error) => error === providerError
  );
  runSync(table.closeAll());
}

async function testKnownEpipeIsAnEvent() {
  const table = new WasiDescriptorTable();
  const pipeError = Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
  const descriptor = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ | RIGHTS.POLL_FD_READWRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: { poll: () => Promise.reject(pipeError) },
  });
  const { guest, host } = makeHost(table, true);
  const events = await runPollAsync(host, guest, [
    fd(71, EVENT_FD_READ, descriptor),
  ]);
  assertPollEvent(events, 71, EPIPE, EVENT_FD_READ);
  runSync(table.closeAll());
}

async function testSyncPromiseOnlyPollIsNotSupported() {
  const table = new WasiDescriptorTable();
  let callbackCount = 0;
  const descriptor = table.allocate({
    kind: 'stdio',
    offset: 0n,
    rightsBase: RIGHTS.FD_READ | RIGHTS.POLL_FD_READWRITE,
    rightsInheriting: 0n,
    flags: 0,
    stdio: {
      poll() {
        callbackCount++;
        return Promise.reject(new Error('async readiness'));
      },
    },
  });
  const { guest, host } = makeHost(table, false);
  const unhandled = [];
  const listener = (event) => unhandled.push(event.reason);
  addEventListener('unhandledrejection', listener);
  try {
    const events = runPollSync(host, guest, [
      fd(81, EVENT_FD_READ, descriptor),
    ]);
    strictEqual(callbackCount, 1);
    assertPollEvent(events, 81, ENOTSUP, EVENT_FD_READ);
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(unhandled, []);
  } finally {
    removeEventListener('unhandledrejection', listener);
    runSync(table.closeAll());
  }
}

export async function runWasiPollTests() {
  testRegularFilesAndFdErrors();
  testPollRightsArePerSubscription();
  await testStdioReadinessAndHangup();
  await testClockWinsAndAbortsBlockedStdio();
  await testReadyFileBeatsFutureClock();
  await testProviderErrors();
  await testKnownEpipeIsAnEvent();
  await testSyncPromiseOnlyPollIsNotSupported();
}
