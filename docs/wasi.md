# WASI preview1

`node:wasi` runs WebAssembly modules that import the WASI preview1 ABI. Enable
`nodejs_wasi_preview1`, `enable_nodejs_wasi_module`, and Node.js compatibility
in the Worker configuration. The preview1 implementation is opt-in and has no
compatibility enable date. Without `nodejs_wasi_preview1`, the existing `WASI`
constructor remains a stub.

The host supports both `wasi_snapshot_preview1` and the legacy `wasi_unstable`
import namespace. The `version` option selects the namespace. The filesystem
provider and `AsyncWASI` APIs are workerd extensions.

## Synchronous execution

Import `WASI` from `node:wasi`, instantiate a module with `wasi.getImportObject()`,
then call `wasi.start(instance)` for a command or `wasi.initialize(instance)` for a
reactor. A command exports `_start`; a reactor may export `_initialize`. Both must
export a `WebAssembly.Memory` named `memory`.

`start()` returns the exit code and releases the host's descriptors. `initialize()`
keeps a reactor's descriptors open until `close()`. Each host binds one instance.
Arguments, environment values and preopened directories are explicit constructor
options. `returnOnExit` defaults to `true`. With `returnOnExit: false`, `proc_exit`
throws a `WasiExit` error with a numeric `code`; it does not terminate the Worker.

All provider and stdio callbacks used by `WASI` must complete synchronously. An
unexpected Promise throws rather than reporting an operation as complete. The
host cannot cancel work that a provider has already started.

## Asynchronous execution

`AsyncWASI` has Promise-returning `start()`, `initialize()` and `close()` methods.
After initializing a reactor, call `await wasi.run(instance.exports.functionName,
...args)` for each exported function. Calls on one host must not overlap.

The host wraps each WASI import in `WebAssembly.Suspending` and enters the export
through `WebAssembly.promising`. This lets a Wasm import wait for a provider or
stdio Promise. The import boundary must be directly under the Wasm guest. Calling
a suspending import through an intervening synchronous JavaScript callback does
not make that callback asynchronous.

Instantiate precompiled Wasm modules in a request context. The complete
[preview1 sample](../samples/wasi-preview1/README.md) supplies a deliberately
delayed provider, exchanges binary stdin/stdout, and reads the guest's arguments
and environment. Its Bazel test exercises the request handler.

## Filesystem providers

`mounts` supplies entries with an absolute guest `path` and a `storage` provider.
Optional `root` selects a retained inode capability inside that provider;
`readOnly` limits mutations and inheritable rights. On a read-only mount,
`path_open` removes mutation rights from requested rights, so guests can use
broad masks for ordinary reads. Unknown rights and other parent capability
limits are rejected. The granted rights are reported by `fd_fdstat_get`. Node-compatible `preopens`
map guest paths to paths in workerd's virtual `node:fs` filesystem. They do not
open arbitrary operating-system paths.

The exported `Storage`, `AsyncStorage`, `Mount`, and related types describe the
provider contract. A provider owns inode identity, file bytes and atomic namespace
mutations. The host owns guest descriptors, shared open descriptions, offsets,
rights, path traversal and WASI errno translation. Absolute symbolic-link
targets resolve from the preopened directory capability, rather than from a
shared guest root; providers should use relative targets for portable links. Inode identities are `bigint`
values and must not be reused during a provider's lifetime. Files and offsets use
`bigint` values from zero through `2^63 - 1`.

`lookup()` takes one name component and does not follow symlinks. `readdir()` omits
`.` and `..`. `create()` returns a retained inode. `retain()` and `release()` keep
an open inode alive across unlink. `append()` atomically chooses the offset and
writes bytes. Providers throw errors with symbolic POSIX `code` values, such as
`ENOENT`; unexpected exceptions propagate. Buffers belong to the host rather than
guest memory. Providers must complete all use of a buffer before returning or
resolving their Promise.

For `AsyncStorage`, every operation returns a Promise. A delayed read can suspend
the guest while another task grows its memory. The host checks fresh memory views
when it resumes; writes use copied input bytes. Calls larger than the host's
transfer limit may return a bounded short transfer. The caller can continue from
the reported count.

The native virtual-filesystem adapter retains its existing limits: file sizes
and offsets are at most `2^32 - 1`, hard-link counts are reported as one, access
time is zero, and modification/change times have the precision available from
`node:fs`. An application provider can supply larger offsets and finer timestamps.

## Standard input and output

`stdio` is a tuple of three borrowed endpoints. Endpoints can implement
`readInto(target, flags)`, `write(source, flags)`, `sync()`, and `poll(direction, signal)`.
Read and write callbacks return a byte count. `AsyncWASI` also awaits Promises.
The host releases descriptors without closing these borrowed endpoints.

An endpoint can opt into `NONBLOCK` with `supportsNonblocking: true`. When the
current flags contain `NONBLOCK`, read and write callbacks must return a count
or throw `EAGAIN` immediately, without starting asynchronous work. A Promise
from such a callback returns `ENOTSUP`; the host cannot cancel work already
started by a callback. Regular-file `path_open` accepts `NONBLOCK`, while
changing regular-file flags to `NONBLOCK` through `fd_fdstat_set_flags` returns
`ENOTSUP`.

`poll()` reports readiness and the number of bytes available for reading or
writing. Its abort signal detaches a readiness subscription when another event
wins. Polling a regular file uses its current shared offset; directories report
an error event. Synchronous polling reports unsupported waits rather than
blocking the isolate.

## Limits

Socket operations and `proc_raise` return `ENOSYS`. Process and thread CPU clocks
return `ENOTSUP`; realtime and monotonic clocks use the Worker runtime's clocks.
This implementation does not provide process spawning or a POSIX ownership/mode API.
Filesystem providers remain responsible for their own durable storage and
replication policies.

The host rejects invalid guest-memory ranges, malformed paths, missing descriptor
rights and traversal outside a preopen capability. A stale moved or unlinked
ancestor returns `ESTALE`. A guest pathname does not give access to a different
mount unless the corresponding directory capability was explicitly supplied.
