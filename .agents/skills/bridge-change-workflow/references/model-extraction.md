# Model Extraction Playbook

Read when: extracting a model out of `Camera` (or splitting another large module), or when
`test/camera-coupling.test.js` fails.

## Recipe (one model per commit, `make check` green each time)

1. Pick a slice that owns several fields plus the rules about them, needs only a few methods from callers, and is
   testable alone. Measure first: `grep -n "this\.<field>" src/domain/camera.js`.
2. Test first: write `test/domain/camera/<model>.test.js` from today's behavior (literal values, no `Camera`). Run
   `.venv/node/bin/node --test test/domain/camera/<model>.test.js` and confirm it fails with `Cannot find module`.
3. Implement `src/domain/camera/<model>.js` (`// @ts-check`, JSDoc, at most 3 parameters or one options object, a
   callback for logging, `/** @type {string} */` on state fields). Tests pass.
4. Delegate from `camera.js`: replace the constructor fields with `this.<owner> = new Model(...)`, turn the `Camera`
   methods and accessors into one-line delegates, drop unused imports and constants (`tsc` has `noUnusedLocals`).
   Delete any leftover `/** @type {...} */` comment above a replaced field, it retypes the new property.
5. Format and lint: `PATH="$PWD/.venv/node/bin:$PATH" .venv/node_modules/.bin/prettier --write <js files>`, then
   `make lint-prune` (or `make lint-baseline` when suppressions move to a new file; review the diff and keep the
   trailing newline in `scripts/eslint-suppressions.json`).
6. `make check`, then update `docs/architecture.md`, the file map in `docs/ACCEPTANCE.md`, `CHANGELOG.md`, and
   `docs/TODO.md` (keep every line at 120 columns; `make format-docs` does not rewrap prose).

## Traps found so far

- `test/camera-coupling.test.js` (type-checked with the TypeScript API) fails on any `Camera` instance-field access
  outside `camera.js` in both `src/` and `test/`. Add an intention-revealing method or accessor on `Camera` plus a test
  instead of reading or writing a field directly.
- The logger resolves the `[STATE]` tag only from an explicit scope: a name string, `{name, state}`, or an object with
  `getLogScope()` (`Camera`, `BackfillJob`). Sub-FSM scopes are plain `{name, state}` objects.
- Locked `test/acceptance/AT-NN.test.js`: never weaken, skip, or delete any `AT-01..AT-19` assertion unless the user
  explicitly approves a requirement change (updating `docs/acceptance/AT-NN.md` and `test/acceptance/AT-NN.test.js`
  together).
- `eventActive` and `eventPriority` stay on `Camera` (session semantics).
- The Dockerfile builder stage runs the tests without `typescript`, so the coupling test skips there.
- `.tmp/` is ignored scratch space (codemods and measuring scripts live there and are not committed). To find
  `Camera` accesses by type, copy the program setup from `test/camera-coupling.test.js`.
