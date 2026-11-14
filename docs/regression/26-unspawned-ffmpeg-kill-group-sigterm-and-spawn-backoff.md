# 26. Unspawned FFmpeg Process-Group SIGTERM, Spawn-Error Detach & Reporter IPC Crash

- **Cause:** Container builds in `deploy/Dockerfile` (`node:22-alpine3.23` builder stage, where `ffmpeg` is not
  installed) failed silently at `STEP 9/9` (`node --test`) due to three interacting bugs: (1) when `spawn('ffmpeg')`
  failed with `ENOENT`, `stopDecoder()`, `stopEncoderProcess()`, `killWedgedEncoder()`, and `pauseEncoderForOffline()`
  called `proc.kill('SIGTERM' | 'SIGKILL')` before `process.nextTick(onErrorNT)` closed the failed C++ `ProcessWrap`
  handle (`proc.pid === undefined`, `uv_process_t.pid === 0`), invoking POSIX `kill(0, SIGTERM)` and terminating the
  entire process group including the parent `node --test` runner; (2) `startEncoder()`, `startDecoder()`, and
  `startRtspDecoder()` only detached handles inside `exit` listeners rather than `error` listeners, leaving
  `hasEncoderProcess()`, `hasDecoderProcess()`, and `isWakingRtspOnStation()` wedged when `spawn` emitted `error`
  without `exit`; and (3) `test/reporter.js` ignored file/suite-level crashes and called `String(err)` on null-prototype
  IPC error objects, throwing `TypeError: Cannot convert object to primitive value` before yielding any output.
- **Fix:** Added `Camera.canSignalProcess(proc)` so `.kill()` is never invoked on a `ChildProcess` whose `pid` is
  `undefined` or `<= 0`; unified `error` and `exit` settlement with exponential retry backoff across `startEncoder()`,
  `startDecoder()`, and `startRtspDecoder()`; hardened `test/reporter.js` with `util.inspect()` formatting and
  non-rollup suite failure reporting; and isolated `test/services.test.js` with an in-memory `global.fetch` stub and
  loopback RTSP fixture URLs.
- **Tests:** `test/media.test.js` (`detaches encoder and decoders and schedules backoff retries when FFmpeg fails to
spawn without emitting exit`) and `test/config.test.js` (`formats null-prototype IPC errors and suite-level worker
crashes in test/reporter.js without throwing or hiding failures`).
