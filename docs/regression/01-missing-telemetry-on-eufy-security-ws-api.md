# 1. Missing Telemetry on `eufy-security-ws` API Schema 13-21

- **Cause:** In schema 13+, `start_listening` returns `result.state.devices` as an array of serial number strings
  (`["SN0000000000", ...]`) rather than device objects, so `dev.serialNumber` was `undefined`.
- **Fix:** Added `fetchAllCameraTelemetry()` to explicitly invoke `device.get_properties` per camera after
  `start_listening`, unwrapping both direct values and `{ value }` metadata objects.
