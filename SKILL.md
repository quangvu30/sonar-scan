---
name: sonar-scan
description: Scan JS/TS code for SonarQube issues and estimate the SonarQube Quality Gate locally, without a SonarQube server — runs Sonar's JS/TS rules (ESLint + eslint-plugin-sonarjs), and in --gate mode checks the PR conditions on new code: New issues = 0, Coverage on new code ≥ 75%, Duplicated lines on new code ≤ 5%. Use when the user asks to "quét sonar", check Sonar issues / quality gate / coverage / duplication before pushing, or verify a fix clears a Sonar finding. Works from any project directory (global skill) and never modifies the scanned project.
---

# Sonar Scan (local)

## Overview

Two modes, both run from the project directory (git root = project root):

1. **Issue scan** (default) — SonarJS `recommended` rules on changed files / paths / whole project.
2. **Quality Gate** (`--gate`) — emulates the SonarQube PR analysis on *new code* (lines added/changed vs the merge-base with the target branch, including uncommitted and untracked files) for the 3 conditions of the SSI gate:

| Condition | How it is computed locally |
|---|---|
| New issues `= 0` | SonarJS rules, only issues on new lines. Plus server-only rules in `lib/server-rules.cjs`: `TODO` (S1135) flags every TODO, even `TODO(ABC-123)` (plugin v4 ignores those); `prefer-node-protocol` (S7772) flags Node built-ins imported without the `node:` prefix (`import ... from 'crypto'`, `require('fs')`, `import('zlib')`, `export ... from 'os'`) — missed by the plugin, found on server in auth-service-fo PR 390. |
| Coverage on new code `≥ 75%` | Runs the project's own jest (`--coverage --runInBand`, project's `collectCoverageFrom` kept, output to a temp dir). Sonar formula `(covered lines + covered conditions) / (lines to cover + conditions)` on new lines. Files **not in lcov** (e.g. outside `collectCoverageFrom`) count as fully uncovered on their SonarJS "executable lines" — this is what makes server coverage lower than jest's own report. Test files are excluded (`**/*.spec.*`, `**/*.test.*`, `**/*.e2e-spec.ts`). |
| Duplicated lines on new code `≤ 5%` | Sonar-like CPD over all source files: tokens with string literals → `LITERAL`, imports skipped, 10-line blocks, clones ≥ 100 tokens. `% = duplicated new lines / new lines`; spec files are part of sources and count. |

Calibrated on analysis-report-fo PR 43 (IBD-20860): server 1 issue / 67.7% / 5.34% (749 lines) vs local 1 / 67.7% / 5.35% (747 lines).

Everything (ESLint 10, sonarjs plugin, `@typescript-eslint/parser`, TypeScript, minimatch) lives in this skill's directory; ESLint config and coverage output go to temp dirs and are deleted. The project's files, config, `coverage/` and `node_modules` are not touched.

## Location

- Script: `/home/quangvd/.claude/skills/sonar-scan/sonar_scan.mjs` (Node ≥ 20); helpers in `lib/` (`newcode`, `eslint`, `coverage`, `cpd`, `server-rules.cjs`).
- Dependencies auto-install on first run. npm on this machine enforces a minimum release age, so keep `package.json` versions as ranges.

## Commands

```bash
SCAN=/home/quangvd/.claude/skills/sonar-scan/sonar_scan.mjs

# Quality Gate on new code (what the PR decoration shows)
node $SCAN --gate                      # base auto: dev → develop → main → master (local or origin/)
node $SCAN --gate --base main          # target branch of the MR
node $SCAN --gate --lcov coverage/lcov.info   # reuse an existing lcov instead of running jest
node $SCAN --gate --no-coverage        # issues + duplication only (fast, ~3s)
# scope/thresholds (defaults read from sonar-project.properties if present, else src/ + defaults above):
#   --sources src,lib  --exclusions <globs>  --coverage-exclusions <globs>  --cpd-exclusions <globs>
#   --min-coverage 75  --max-duplication 5  --max-new-issues 0

# Issue scan
node $SCAN                      # files changed vs base + uncommitted + untracked
node $SCAN src/foo src/bar.ts   # explicit files/dirs
node $SCAN --all --summary      # whole project, counts by rule/file
node $SCAN -f json              # formats: stylish | json | json-with-metadata | html

# Common: --no-type-check (skip type-aware rules), --plugin-todo (plugin v4 TODO behavior), --cwd <repo>
```

Exit codes: `0` clean / gate passed, `1` issues found / gate failed, `2` usage or setup error. `--gate` with coverage runs the whole jest suite (~30s on a mid-size repo); tests failing are reported as a warning (CI would fail before Sonar).

## Workflow

1. When the user mentions the Sonar quality gate, coverage or duplication → run `--gate`. Otherwise run the default issue scan (or `--all --summary` for a whole-project view).
2. Report each condition with the numbers and the details the script prints (issue locations, uncovered new lines per file, clone pairs). For issue scans, separate findings **introduced by the branch** from **pre-existing** ones (`git blame -L <line>,<line> <file>`).
3. Explain causes concretely, e.g. "file X is outside jest `collectCoverageFrom`, so Sonar counts its 16 new executable lines as uncovered" or "fixture `sentEntity` duplicated between A and B (2 × 20 lines)".
4. Propose fixes but don't apply them until the user asks. Typical fixes:
   - Issues: fix the code; a deliberate TODO still fails the gate — tell the user (ask before removing it).
   - Coverage: add tests for uncovered new lines, or — if a file is tested but outside `collectCoverageFrom` — say so and ask before changing the project's jest config (that changes CI behavior).
   - Duplication: extract shared test fixtures/helpers rather than suppressing.
5. After fixes, re-run `--gate` plus the project's own lint/tests.

## Adding a rule the server flags but the local scan misses

When a Sonar server finding does not show up locally: add an ESLint rule to `lib/server-rules.cjs`, enable it as `sonar-server/<name>` in `lib/eslint.mjs`, test it on a throwaway file with `--cwd <tmpdir> <file>`, and list it in the table above.

## Limitations (say so when relevant)

- Estimates, not the server: rule set is the plugin `recommended` profile (not the project's actual Quality Profile); CPD and executable-line logic are re-implementations, so numbers can differ slightly (e.g. new-line counts differ by a couple of lines).
- New code = git diff vs merge-base of `HEAD` with the base; the server uses its own SCM data for the PR.
- Coverage only for jest projects (otherwise pass `--lcov` or `--no-coverage`). No security hotspot review, no taint analysis.
- For exact parity use SonarQube for IDE (Connected Mode) or `sonar-scanner` against the server (token from env, never hard-coded).
