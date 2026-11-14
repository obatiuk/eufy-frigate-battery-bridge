---
name: bridge-change-workflow
description: >-
  Use before changing src/, test/, docs/, or CHANGELOG.md in the Eufy Frigate bridge, or when writing or updating
  acceptance criteria and acceptance tests. Gives the step-by-step procedures for a code change, a bug fix with a
  regression entry, an acceptance criterion change, and backlog updates, plus which documents to read for which files.
---

# Bridge Change Workflow

The always-on rules and the doc map are in `AGENTS.md`. This skill is the checklist for doing the work.

## 1. Any code change

1. Read `docs/ACCEPTANCE.md` sections 1 and 3 (file and concern maps), then the `docs/acceptance/AT-NN.md` files listed
   for your files and subsystem concern.
2. Read the `docs/` documents from the doc map that match the topic (for example `docs/stream-lifecycle.md` for wake
   or backfill logic).
3. Red: add or update a test in `test/*.test.js` (start the body with `// Verify ...` or `// Regression: ...`). Run
   `make test` and confirm it fails for the expected reason.
4. Green: change `src/` without editing the Red test. Run `make check` until it passes.
5. If config keys, defaults, or bounds changed, sync `src/config.js`, `deploy/config.schema.json`,
   `deploy/config.example.*.yaml`, and `README.md` (`test/config.test.js` checks schema defaults). If user-visible
   behavior changed, update `README.md`. If you finished a `docs/TODO.md` item, move it to `CHANGELOG.md` as one
   plain-language line (no file paths or code symbols).

## 2. Bug fix or regression

1. Do section 1, with a regression test that reproduces the bug.
2. Find the next number in `docs/REGRESSION.md`. Create `docs/regression/NN-slug.md` with a concise
   `# NN. Title` (`<= 100` characters; put longer scope lists in a `- **Scope:**` bullet) and the bullets `Cause` and
   `Fix` (keep the file under 4 KB).
3. Add one matching row to `docs/REGRESSION.md` (`#`, identical `Title` linking to `regression/NN-slug.md`, `src/`
   filenames, related `AT-NN`); `make docs-check` validates parity.
4. Update or remove the matching item in `docs/TODO.md`.

## 3. Acceptance criteria and tests

Follow `tdd-workflow` (only when the user asks or approves; literal expected values, enforced by `make docs-check`).

1. Edit or create `docs/acceptance/AT-NN.md` and sync `docs/ACCEPTANCE.md` section 2 (index) and section 3 (file and
   concern maps); `make docs-check` enforces 1:1 parity with `it('AT-NN: ...')` in `test/acceptance.test.js`.
2. Write or extend `AT-NN` in `test/acceptance.test.js`.
3. Run Red first (the new assertions must fail), then Green, then `make check`.
4. Add a regression entry (section 2) when the change fixes a defect.

## 4. Docs only

- Run `make format-docs` then `make docs-check` before finishing. Fix long lines instead of ignoring the check.
- Keep `AGENTS.md` under 8 KB; move any new reference text into `docs/` and link it from the doc map.
- Do not copy text between documents; link to the single source.
