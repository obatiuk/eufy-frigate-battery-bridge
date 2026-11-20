# 59. Harden Eufy RPC `call()`, Check `set_api_schema` & Guard Floating Background RPCs

- **Scope:** `src/services/eufy/ws-transport.js`, `src/services/orchestrator/wake.js`, `AT-05`, `AT-06`, `AT-08`
- **Cause:** `call()` invoked `ws.send(...)` outside a `try/catch` inside its `Promise` executor, so a socket closing
  between the `readyState === WS_OPEN` check and `ws.send()` threw synchronously, rejecting the returned `Promise` and
  leaving `pendingRpcMap` and `timeoutTimer` dangling. Meanwhile, `handleVersionMessage()` ignored failed
  `set_api_schema` responses before calling `start_listening`, and floating `.then(...)` chains in
  `refreshOfflineCameraOnApiWake()` and post-stop `device.get_properties` lacked `.catch(...)` handlers.
- **Fix:** Wrapped `JSON.stringify` and `ws.send(...)` inside `call()` in `try/catch`, cleaning up `pendingRpcMap` and
  `timeoutTimer` and resolving `{success: false, errorCode: formatErrorMessage(err)}` so `call()` never rejects. Checked
  `set_api_schema` in `handleVersionMessage()` so failures mark `wsReady = false`, log the `RPC` error, schedule a
  reconnect, and abort before `start_listening`, and added `.catch(...)` logging guards to the background `.then(...)`
  chains in `wake.js` and `ws-transport.js`.
