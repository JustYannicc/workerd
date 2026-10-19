(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (export "memory") 1)
  (data (i32.const 128) "\00\ffA")

  (func (export "_start")
    (local $error i32)
    i32.const 0
    i32.const 128
    i32.store
    i32.const 4
    i32.const 3
    i32.store
    i32.const 1
    i32.const 0
    i32.const 1
    i32.const 16
    call $fd_write
    local.tee $error
    if
      local.get $error
      call $proc_exit
      unreachable
    end
    i32.const 7
    call $proc_exit
    unreachable)
)
