# Operations: commands and diagnostic scripts

Read when: you need a build, test, publish, health check, or signal-driven diagnostic command.

## Key Commands

- **List Available Make Targets:** `make` or `make help`
- **Bootstrap Hermetic Local Environment:** `make env` (automatically downloads a project-local Node.js runtime into
  `.venv/node` and installs `package.json` dependencies into `.venv/node_modules` with isolated `HOME=.venv/home`,
  `NPM_CONFIG_CACHE=.venv/npm-cache`, and `NPM_CONFIG_USERCONFIG=.venv/npmrc` - never touching global `$HOME` caches or
  settings)
- **Check for Unused / Unreachable Code & Static Types:** `make deadcode` (runs
  `.venv/node_modules/.bin/tsc --project scripts/tsconfig.json` with `noUnusedLocals`, `noUnusedParameters`, and
  `allowUnreachableCode: false`, plus `.venv/node_modules/.bin/knip` for unused files, exports, and dependencies)
- **Run Syntax Check & Test Suites:** `make test` (auto-creates `.venv` if missing, checks JavaScript syntax across
  `src/`, `test/reporter.js`, and `test/*.test.js` via `.venv/node/bin/node --check`, and runs all unit and locked
  acceptance tests via `.venv/node/bin/node --test --test-reporter=./test/reporter.js test/*.test.js`)
- **Run Full Quality Gate:** `make check` (runs `deadcode`, `lint`, `docs-check`, and `test`)
- **Build Image Locally:** `make docker-build` (runs `make check` and executes `node --test` with `test/reporter.js`
  inside the `node:22-alpine3.23` builder stage before building the minimal `alpine:3.23` Node 22 runtime image)
- **Publish Locally:** `make publish` (builds and tags `localhost/eufy-frigate-battery-bridge:latest`; skips remote push
  when `REGISTRY` is empty)
- **Publish Dev Image (`:dev`):**
  `make publish REGISTRY=ghcr.io/obatiuk BUILD_VERSION=dev PUBLISH_TAG=dev` (builds and pushes only `:dev` on
  `main`/`master` branch pushes without moving `:latest`)
- **Publish Release Image (`:vX.Y.Z` + `:latest`):**
  Update `package.json` and `package-lock.json` to `X.Y.Z` before creating tag `vX.Y.Z`, then run
  `make publish REGISTRY=ghcr.io/obatiuk` (when `BUILD_VERSION` starts with `v`, pushes both `:$(BUILD_VERSION)` and
  `:$(PUBLISH_TAG)` with `--tls-verify=$(TLS_VERIFY)`, where `PUBLISH_TAG` defaults to `latest`)
- **Clean Images & Local Environment:** `make clean` (removes local build/publish container images, prunes cached build
  layers labeled with `org.opencontainers.image.source`, and deletes `.tmp/`, `.venv/`, and `node_modules/`)
- **Print Makefile Variables:** `make print-vars`
- **Check Bridge Readiness:**
  `podman exec eufy-frigate-battery-bridge wget -qO- http://127.0.0.1:8080/healthz` (`GET`/`HEAD /healthz` or `/health`;
  or `curl -s http://127.0.0.1:8080/healthz` if port `8080` is published to the host)
- **Check Bridge Build Version, Commit & Runtime Config:**
  `podman exec eufy-frigate-battery-bridge wget -qO- http://127.0.0.1:8080/api/config` (`GET`/`HEAD /api/config`; or
  `curl -s http://127.0.0.1:8080/api/config` if port `8080` is published to the host)
- **Trigger External Camera Pre-Wake:**
  `curl -s -X POST http://127.0.0.1:8080/api/wake/all -d '{"reason":"test","duration":30}'` (also accepts `GET` query
  parameters `duration`, `reason`, `create_event` on `/api/wake` or `/api/wake/:cameras`; skips direct `rtsp_url`
  cameras with `status: "unsupported"` in `all`/mixed targets and returns `422` when targeted directly, failing
  atomically on unknown camera tokens, malformed payloads, or disconnected/offline targets)
- **Trigger Test Frigate Event:** `podman kill -s USR2 eufy-frigate-battery-bridge` (files a `"test"` event on the first
  camera without waking it, and sends an `HA_WEBHOOK_URL` notification if configured)
- **Trigger Test Backfill Download:** `podman kill -s USR1 eufy-frigate-battery-bridge` (picks the first non-`RTSP`
  camera, or last camera, queries `HomeBase 3`, and replays its latest `.zxvideo` clip at `live_fps` into Frigate)

<details>
<summary><strong>Diagnostic Script 1: Inspect Hardware Models, Serials & Firmware</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const WS = require("ws");
  const wsUrl = process.env.EUFY_WS_URL ||
    ("ws://" + (process.env.EUFY_WS_HOST || "eufy-security-ws") + ":" + (process.env.EUFY_WS_PORT || "3000"));
  const ws = new WS(wsUrl);
  let id = 0;
  let remaining = 0;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));
  const unwrap = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      const stations = m.result?.state?.stations || [];
      const devices = m.result?.state?.devices || [];
      remaining = stations.length + devices.length;
      for (const s of stations) send({ command: "station.get_properties", serialNumber: s.serialNumber || s });
      for (const d of devices) send({ command: "device.get_properties", serialNumber: d.serialNumber || d });
      if (!remaining) process.exit(0);
      setTimeout(() => process.exit(0), 3000);
    } else if (m.type === "result" && m.result?.properties) {
      const p = m.result.properties;
      console.log(
        unwrap(p.name) +
          " | model=" + unwrap(p.model) +
          " | serial=" + unwrap(p.serialNumber) +
          " | fw=" + unwrap(p.softwareVersion) +
          " | hw=" + unwrap(p.hardwareVersion)
      );
      if (--remaining <= 0) process.exit(0);
    }
  });
'
```

</details>

<details>
<summary><strong>Diagnostic Script 2: Inspect Power Manager, RTSP & Telemetry State</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const fs = require("node:fs");
  const jsYaml = require("js-yaml");
  const WS = require("ws");
  const cfgPath = process.env.BRIDGE_CONFIG || "/config/config.yaml";
  const cfg = jsYaml.load(fs.readFileSync(cfgPath, "utf8"));
  const wsUrl = process.env.EUFY_WS_URL ||
    ("ws://" + (process.env.EUFY_WS_HOST || "eufy-security-ws") + ":" + (process.env.EUFY_WS_PORT || "3000"));
  const ws = new WS(wsUrl);
  let id = 0;
  let remaining = cfg.cameras.length;
  const send = (cmd) => ws.send(JSON.stringify({ messageId: String(++id), ...cmd }));
  const unwrap = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      for (const c of cfg.cameras) send({ command: "device.get_properties", serialNumber: c.serial });
      setTimeout(() => process.exit(0), 3000);
    } else if (m.type === "result" && m.result?.properties) {
      const p = m.result.properties;
      console.log(
        unwrap(p.name) + " (" + unwrap(p.serialNumber) + "): " +
          "powerMode=" + unwrap(p.powerWorkingMode) + " (0=Battery, 1=Surveillance, 2=Custom)" +
          ", clipLen=" + unwrap(p.recordingClipLength) + "s" +
          ", endEarly=" + unwrap(p.recordingEndClipMotionStops) +
          ", retrigger=" + unwrap(p.recordingRetriggerInterval) + "s" +
          ", quality=" + unwrap(p.videoStreamingQuality ?? p.streamingQuality) +
          ", rtsp=" + unwrap(p.rtspStream) + " (" + (unwrap(p.rtspStreamUrl) || "n/a") + ")" +
          ", light=" + unwrap(p.light) +
          ", state=" + unwrap(p.state) +
          ", bat=" + unwrap(p.battery ?? p.batteryLevel) + "% (chg=" + unwrap(p.chargingStatus) + ")" +
          ", wifi=" + unwrap(p.wifiSignalLevel) + " (" + unwrap(p.wifiRssi) + " dBm)" +
          ", temp=" + unwrap(p.batteryTemperature ?? p.temperature) + "C"
      );
      if (--remaining <= 0) process.exit(0);
    }
  });
'
```

</details>

<details>
<summary><strong>Diagnostic Script 3: Inspect Latest HomeBase 3 Clips</strong></summary>

```shell
podman exec eufy-frigate-battery-bridge node -e '
  const WS = require("ws");
  const wsUrl = process.env.EUFY_WS_URL ||
    ("ws://" + (process.env.EUFY_WS_HOST || "eufy-security-ws") + ":" + (process.env.EUFY_WS_PORT || "3000"));
  const ws = new WS(wsUrl);
  let id = 0;
  let remaining = 0;
  const connectIds = new Map();
  const send = (cmd) => {
    const messageId = String(++id);
    ws.send(JSON.stringify({ messageId, ...cmd }));
    return messageId;
  };

  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "version") {
      send({ command: "set_api_schema", schemaVersion: Math.min(m.maxSchemaVersion, 21) });
      send({ command: "start_listening" });
    } else if (m.messageId === "2") {
      const stations = m.result?.state?.stations || [];
      remaining = stations.length;
      if (!remaining) process.exit(0);
      for (const s of stations) {
        const serialNumber = s.serialNumber || s;
        connectIds.set(send({ command: "station.connect", serialNumber }), serialNumber);
      }
      setTimeout(() => process.exit(0), 5000);
    } else if (m.type === "result" && connectIds.has(m.messageId)) {
      send({ command: "station.database_query_latest_info", serialNumber: connectIds.get(m.messageId) });
    } else if (m.type === "event" && m.event?.event === "database query latest") {
      console.log("Station " + m.event.serialNumber + " latest records:", JSON.stringify(m.event.data, null, 2));
      if (--remaining <= 0) process.exit(0);
    }
  });
'
```

</details>

## Quality gates and documentation tooling

- `make format`: `prettier --write` (`120` columns, single quotes, 2-space indent) across `src/`, `scripts/`, `test/`,
  `deploy/`, `package.json`, and all Markdown documentation.
- `make lint`: `eslint` across `src/`, `scripts/`, and `test/` (`max-len` 120 everywhere, plus `max-params` 3,
  `no-magic-numbers`, `complexity` 25, and `max-lines` 1,500 on `src/`) and `prettier --check` on code and JSON/YAML
  files. Existing structural violations are recorded in `scripts/eslint-suppressions.json`; only new ones fail.
- `make lint-prune`: remove suppressions that no longer occur after a cleanup. `make lint-baseline` re-records all
  current violations (use only when deliberately accepting them).
- `make docs-check`: size budgets (`AGENTS.md` 8 KB target / 16 KB hard limit, `docs/` 20 KB each, `.agents/**/SKILL.md`
  4 KB), relative links, ASCII hyphens, 120 columns, PII redaction (`*.md` and `deploy/`), `ACCEPTANCE.md` / `AT-NN.md`
  / `test/acceptance.test.js` 1:1 & literal-assertion parity, `REGRESSION.md` parity, and `prettier --check` tables.
- `make format-docs`: `prettier --write` for `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/`, and `.agents/`.
- `make commit-msg-check MSG=<file>`: validate a commit message (`<= 6` bullets, `<= 8` lines total, no subject line,
  blank line + `Co-authored-by:` trailer, no Markdown escapes, no en/em-dashes, no home-directory paths).
- `make install-hooks`: install a `commit-msg` git hook that runs the same check.
