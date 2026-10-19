# WASI preview1 demo

This Worker gives a WASI guest a delayed in-memory file provider at `/data` and binary stdin/stdout. The guest reads the seeded `note.bin`, appends the request body, rewinds, and writes the full file back to stdout. Its arguments and environment are returned in response headers.

Run the complete request flow through Bazel:

```sh
bazel test //samples/wasi-preview1:demo@
```

To serve it on port 8787, build the guest and runtime, copy the three runtime files plus the generated guest into a temporary directory, and start workerd:

```sh
bazel build //samples/wasi-preview1:guest.wasm //src/workerd/server:workerd
run_dir="$(mktemp -d)"
cp samples/wasi-preview1/config.capnp samples/wasi-preview1/worker.js samples/wasi-preview1/provider.js "$run_dir/"
cp bazel-bin/samples/wasi-preview1/guest.wasm "$run_dir/guest.wasm"
bazel-bin/src/workerd/server/workerd serve --experimental "$run_dir/config.capnp"
```

Then send binary input and read the returned bytes:

```sh
printf '\000\377A' | curl --data-binary @- http://127.0.0.1:8787/demo --output response.bin
```

`response.bin` starts with `seed:` and ends with the exact request bytes. `X-Wasi-Args` and `X-Wasi-Env` show the guest's argv and environment.
