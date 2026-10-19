(module
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get"
    (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get"
    (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "clock_res_get"
    (func $clock_res_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_fdstat_get"
    (func $fd_fdstat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_fdstat_set_flags"
    (func $fd_fdstat_set_flags (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_fdstat_set_rights"
    (func $fd_fdstat_set_rights (param i32 i64 i64) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_get"
    (func $fd_filestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_set_times"
    (func $fd_filestat_set_times (param i32 i64 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_pread"
    (func $fd_pread (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_pwrite"
    (func $fd_pwrite (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_renumber"
    (func $fd_renumber (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32)
      (result i32)))
  (import "wasi_snapshot_preview1" "path_rename"
    (func $path_rename (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file"
    (func $path_unlink_file (param i32 i32 i32) (result i32)))

  (import "wasi_snapshot_preview1" "fd_readdir"
    (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))

  (memory (export "memory") 1)
  (data (i32.const 7168) "note.bin")
  (data (i32.const 7190) "absent")
  (data (i32.const 7210) "new.bin")
  (data (i32.const 7230) "renamed.bin")
  (data (i32.const 7250) ".")
  (data (i32.const 2048) "Z")

  (func (export "_initialize"))

  (func (export "openPath")
    (param $path i32) (param $length i32) (param $oflags i32)
    (param $rights i64) (param $fdflags i32) (result i32)
    i32.const 3
    i32.const 0
    local.get $path
    local.get $length
    local.get $oflags
    local.get $rights
    i64.const 0
    local.get $fdflags
    i32.const 16
    call $path_open)

  (func (export "openPathRights")
    (param $path i32) (param $length i32) (param $oflags i32)
    (param $base i64) (param $inheriting i64) (result i32)
    i32.const 3
    i32.const 0
    local.get $path
    local.get $length
    local.get $oflags
    local.get $base
    local.get $inheriting
    i32.const 0
    i32.const 16
    call $path_open)

  (func (export "setFdRights")
    (param $fd i32) (param $base i64) (param $inheriting i64) (result i32)
    local.get $fd
    local.get $base
    local.get $inheriting
    call $fd_fdstat_set_rights)

  (func (export "fdStat") (param $fd i32) (param $output i32) (result i32)
    local.get $fd
    local.get $output
    call $fd_fdstat_get)

  (func (export "setFdFlags") (param $fd i32) (param $flags i32) (result i32)
    local.get $fd
    local.get $flags
    call $fd_fdstat_set_flags)

  (func (export "readFd")
    (param $fd i32) (param $iovs i32) (param $length i32) (param $nread i32)
    (result i32)
    local.get $fd
    local.get $iovs
    local.get $length
    local.get $nread
    call $fd_read)

  (func (export "writeFd")
    (param $fd i32) (param $iovs i32) (param $length i32) (param $nwritten i32)
    (result i32)
    local.get $fd
    local.get $iovs
    local.get $length
    local.get $nwritten
    call $fd_write)

  (func (export "renumberFd") (param $from i32) (param $to i32) (result i32)
    local.get $from
    local.get $to
    call $fd_renumber)

  (func (export "exchange") (result i32)
    (local $fd i32)
    (local $error i32)

    ;; Open the seeded file for reading, appending, and seeking.
    i32.const 0
    i32.const 1024
    i32.store
    i32.const 4
    i32.const 64
    i32.store
    i32.const 3
    i32.const 0
    i32.const 7168
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

    ;; Read the seed before appending the binary stdin payload.
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

    ;; Read stdin into owned guest memory, then append it to the file.
    i32.const 0
    i32.const 256
    i32.store
    i32.const 4
    i32.const 64
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
    i32.const 44
    i32.const 20
    i32.load
    i32.store
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

    ;; Rewind and read the whole file back to stdout.
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
    i32.const 64
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

  (func (export "clockInfo") (result i32)
    (local $error i32)
    i32.const 0
    i32.const 48
    call $clock_res_get
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 1
    i32.const 56
    call $clock_res_get
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 0
    i64.const 1000000
    i32.const 448
    call $clock_time_get
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 1
    i64.const 1000
    i32.const 456
    call $clock_time_get)

  (func (export "randomLarge") (result i32)
    i32.const 8192
    i32.const 65537
    call $random_get)

  (func (export "pollOnce") (result i32)
    i32.const 512
    i64.const 659918
    i64.store
    i32.const 528
    i32.const 1
    i32.store
    i32.const 536
    i64.const 1000000
    i64.store
    i32.const 512
    i32.const 608
    i32.const 1
    i32.const 640
    call $poll_oneoff)

  (func (export "bigOffsets") (result i32)
    (local $fd i32)
    (local $error i32)
    i32.const 3
    i32.const 0
    i32.const 7168
    i32.const 8
    i32.const 0
    i64.const 10485862
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
    i64.const 9007199254740995
    i32.const 0
    i32.const 32
    call $fd_seek
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 0
    i32.const 2048
    i32.store
    i32.const 4
    i32.const 1
    i32.store
    local.get $fd
    i32.const 0
    i32.const 1
    i64.const 9007199254740995
    i32.const 24
    call $fd_pwrite
    local.tee $error
    if
      local.get $error
      return
    end
    local.get $fd
    i32.const 0
    i32.const 1
    i64.const 9007199254740995
    i32.const 20
    call $fd_pread
    local.tee $error
    if
      local.get $error
      return
    end
    local.get $fd
    i64.const 9007199254740995
    i64.const 9007199254741004
    i32.const 5
    call $fd_filestat_set_times
    local.tee $error
    if
      local.get $error
      return
    end
    local.get $fd
    i32.const 128
    call $fd_filestat_get)

  (func (export "readEof") (result i32)
    i32.const 0
    i32.const 256
    i32.store
    i32.const 4
    i32.const 64
    i32.store
    i32.const 0
    i32.const 0
    i32.const 1
    i32.const 20
    call $fd_read)

  (func (export "readFault") (result i32)
    i32.const 0
    i32.const 65532
    i32.const 1
    i32.const 20
    call $fd_read)

  (func (export "openMissing") (result i32)
    i32.const 3
    i32.const 0
    i32.const 7190
    i32.const 6
    i32.const 0
    i64.const 2
    i64.const 0
    i32.const 0
    i32.const 16
    call $path_open)

  (func (export "openCreate") (result i32)
    i32.const 3
    i32.const 0
    i32.const 7210
    i32.const 7
    i32.const 1
    i64.const 64
    i64.const 0
    i32.const 0
    i32.const 16
    call $path_open)

  (func (export "renameCreated") (result i32)
    i32.const 3
    i32.const 7210
    i32.const 7
    i32.const 3
    i32.const 7230
    i32.const 11
    call $path_rename)

  (func (export "unlinkRenamed") (result i32)
    i32.const 3
    i32.const 7230
    i32.const 11
    call $path_unlink_file)

  (func (export "readDirectory")
    (param $fd i32) (param $buffer i32) (param $length i32)
    (param $cookie i64) (param $used i32) (result i32)
    local.get $fd
    local.get $buffer
    local.get $length
    local.get $cookie
    local.get $used
    call $fd_readdir)

  (func (export "seekFd")
    (param $fd i32) (param $offset i64) (param $whence i32)
    (param $result i32) (result i32)
    local.get $fd
    local.get $offset
    local.get $whence
    local.get $result
    call $fd_seek)

  (func (export "renumberAndClose") (result i32)
    (local $error i32)
    i32.const 3
    i32.const 0
    i32.const 7250
    i32.const 1
    i32.const 2
    i64.const 16384
    i64.const 0
    i32.const 0
    i32.const 24
    call $path_open
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 16
    i32.load
    i32.const 24
    i32.load
    call $fd_renumber
    local.tee $error
    if
      local.get $error
      return
    end
    i32.const 24
    i32.load
    call $fd_close)
)
