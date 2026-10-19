(module
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get"
    (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get"
    (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32)
      (result i32)))

  (memory (export "memory") 2)
  (data (i32.const 100) "note.bin")

  (func (export "_initialize"))

  (func (export "getArgs") (result i32)
    (local $error i32)
    i32.const 64
    i32.const 68
    call $args_sizes_get
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 72
    i32.const 2048
    call $args_get)

  (func (export "getEnv") (result i32)
    (local $error i32)
    i32.const 80
    i32.const 84
    call $environ_sizes_get
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 88
    i32.const 4096
    call $environ_get)

  (func (export "exchange") (result i32)
    (local $fd i32)
    (local $error i32)

    ;; Read the seeded file, append stdin, then return its exact contents.
    i32.const 0
    i32.const 1024
    i32.store
    i32.const 4
    i32.const 64
    i32.store
    i32.const 3
    i32.const 0
    i32.const 100
    i32.const 8
    i32.const 0
    i64.const 4194374
    i64.const 0
    i32.const 0
    i32.const 16
    call $path_open
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 16
    i32.load
    local.set $fd
    local.get $fd
    i32.const 0
    i32.const 1
    i32.const 20
    call $fd_read
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 40
    i32.const 20
    i32.load
    i32.store
    local.get $fd
    i64.const 0
    i32.const 2
    i32.const 32
    call $fd_seek
    local.tee $error
    if
      local.get $error
      return
    end

    i32.const 0
    i32.const 256
    i32.store
    i32.const 4
    i32.const 4096
    i32.store
    i32.const 0
    i32.const 0
    i32.const 1
    i32.const 20
    call $fd_read
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 4
    i32.const 20
    i32.load
    i32.store
    local.get $fd
    i32.const 0
    i32.const 1
    i32.const 24
    call $fd_write
    local.tee $error
    if
      local.get $error
      return
    end

    local.get $fd
    i64.const 0
    i32.const 0
    i32.const 32
    call $fd_seek
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 0
    i32.const 512
    i32.store
    i32.const 4
    i32.const 8192
    i32.store
    local.get $fd
    i32.const 0
    i32.const 1
    i32.const 20
    call $fd_read
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 4
    i32.const 20
    i32.load
    i32.store
    i32.const 1
    i32.const 0
    i32.const 1
    i32.const 24
    call $fd_write
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 0)
)
