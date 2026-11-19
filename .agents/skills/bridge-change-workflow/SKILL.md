---
name: bridge-change-workflow
description: >-
  Use before investigating behavior or changing src/, test/, docs/, or CHANGELOG.md in the Eufy Frigate bridge, or when
  writing or updating acceptance criteria and acceptance tests. Gives the step-by-step procedures for a code change, a
  bug fix with a regression entry, an acceptance criterion change, and backlog updates, plus which documents to read for
  which files.
---

# Bridge Change Workflow

The always-on rules and the doc map are in `AGENTS.md`. This skill is the checklist for doing the work.

## 1. Any code change

1. Read `docs/ACCEPTANCE.md` sections 1 and 3 (file and concern maps), then the `docs/acceptance/AT-NN.md` files listed
   for your files and subsystem concern.
2. Read the `docs/` documents from the doc map that match the topic (for example `docs/stream-lifecycle.md` for wake
   or backfill logic).
3. Verify validity and Red (`tdd-workflow`): reproduce the `TODO` or expected behavior in `test/<package>/*.test.js`
   (derived from the task, not the code; starting with `// Verify ...` or `// Regression: ...`) and run `make test` to
   confirm the issue still exists and fails before changing `src/`.
4. Green: change `src/` without editing the Red test. Run `make check` until it passes.
5. If config keys, defaults, or bounds changed, sync `src/config/`, `deploy/config.schema.json`,
   `deploy/config.example.*.yaml`, and `README.md` (`test/config/config.test.js` checks schema defaults). If
   user-visible behavior changed, update `README.md`. If you finished a `docs/TODO.md` item, move it to `CHANGELOG.md`
   as one plain-language line (no file paths or code symbols).

6. Extracting a model out of `Camera` or splitting a large module: follow `references/model-extraction.md`.

## 2. Bug fix or regression

1. Do section 1, placing the regression test in `test/regression/NN-slug.test.js` (`Regression NN: ...`, verified by
   `make test-regression`).
2. Find the next number in `docs/REGRESSION.md`. Create `docs/regression/NN-slug.md` with the same `NN-slug` stem, a
   concise `# NN. Title` (`<= 100` characters; put longer scope lists in a `- **Scope:**` bullet), and the bullets
   `Cause` and `Fix` (keep the file under 4 KB).
3. Add one matching line to `docs/REGRESSION.md` (number, identical title linking to `regression/NN-slug.md`, `src/`
   filenames, related `AT-NN`); `make docs-check` validates parity.
4. Update or remove the matching item in `docs/TODO.md`.

## 3. Acceptance criteria and tests

Follow `tdd-workflow` (only when the user asks or approves; literal expected values, enforced by `make docs-check`).

1. Edit or create `docs/acceptance/AT-NN.md` and sync `docs/ACCEPTANCE.md` section 2 (index) and section 3 (file and
   concern maps); `make docs-check` enforces 1:1 parity with `it('AT-NN: ...')` in `test/acceptance/AT-NN.test.js`.
2. Write or extend `AT-NN` in `test/acceptance/AT-NN.test.js`.
3. Run Red first (the new assertions must fail), then Green, then `make check`.
4. Add a regression entry (section 2) when the change fixes a defect.

## 4. Docs only

- Run `make format-docs` then `make docs-check` before finishing. Fix long lines instead of ignoring the check.
- Keep `AGENTS.md` under 8 KB; move any new reference text into `docs/` and link it from the doc map.
- Do not copy text between documents; link to the single source.
