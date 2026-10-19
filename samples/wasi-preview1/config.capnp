using Workerd = import "/workerd/workerd.capnp";

const wasiPreview1Demo :Workerd.Config = (
  services = [(name = "wasi-preview1-demo", worker = .worker)],
  sockets = [(name = "http", address = "*:8787", http = (), service = "wasi-preview1-demo")]
);

const worker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker.js"),
    (name = "provider.js", esModule = embed "provider.js"),
    (name = "guest.wasm", wasm = embed "guest.wasm"),
  ],
  compatibilityDate = "2026-10-18",
  compatibilityFlags = [
    "nodejs_compat",
    "nodejs_compat_v2",
    "enable_nodejs_wasi_module",
    "nodejs_wasi_preview1",
  ],
);
