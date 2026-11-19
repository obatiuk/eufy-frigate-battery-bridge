# 51. Eufy WebSocket Keepalive Pings, Handshake Timeout & Jittered Reconnect Backoff

- **Cause:** `connectWs()` in `src/services/eufy/ws-transport.js` omitted `handshakeTimeout`, sent no WebSocket
  `ping` frames or inactivity timeout, and reconnected on a fixed `10s` delay. A silently dropped NAT/router or
  container TCP connection could leave `wsReady = true` indefinitely without reconnecting, and a stalled post-open
  `version` handshake hung forever.
- **Fix:** Passed `{handshakeTimeout: 10000}` to `new WebSocket(...)`, added a `10s` post-open `version` handshake
  watchdog, added a `30s` `ping` keepalive loop with a `10s` `pong`/inbound-message timeout that terminates dead
  half-open sockets (`terminate()`), and replaced the fixed `10s` reconnect delay with bounded jittered exponential
  backoff (`computeWsReconnectDelayMs`, `10s` initial up to `60s` max, resetting on successful `start_listening`).
- **Tests:** `test/services/eufy/modules.test.js` (`computes bounded exponential reconnect backoff...`) and
  `test/regression/51-websocket-keepalive-ping-handshake-timeout-and-backoff.test.js`.
