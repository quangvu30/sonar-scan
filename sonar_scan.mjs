#!/usr/bin/env node
// Quét issue SonarJS và ước lượng Quality Gate của SonarQube trên local. Không
// sửa project được quét: dependency nằm trong thư mục skill, config/coverage
// sinh tạm trong thư mục temp rồi xóa.
//
// Usage:
//   node sonar_scan.mjs                 # issue trên file thay đổi so với base branch + working tree
//   node sonar_scan.mjs --all           # issue trên toàn bộ project
//   node sonar_scan.mjs src/a.ts src/b  # issue trên file/thư mục cụ thể
//   node sonar_scan.mjs --gate          # Quality Gate trên new code: new issues, coverage, duplication
// Xem SKILL.md cho toàn bộ option.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  IGNORES,
  ensureDeps,
  fail,
  git,
  isJsTs,
  log,
  readSonarProperties,
  requireFromSkill,
  resolveBase,
  splitList,
} from './lib/common.mjs';
import { runEslint, writeEslintConfig } from './lib/eslint.mjs';

const FORMATS = ['stylish', 'json', 'json-with-metadata', 'html'];
const DEFAULT_COVERAGE_EXCLUSIONS = [
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.e2e-spec.ts',
];

function parseArgs(argv) {
  const opts = {
    base: null,
    all: false,
    gate: false,
    format: 'stylish',
    summary: false,
    typeCheck: true,
    serverTodo: true,
    cwd: process.cwd(),
    paths: [],
    sources: null,
    exclusions: null,
    coverageExclusions: null,
    cpdExclusions: null,
    lcov: null,
    coverage: true,
    minCoverage: 75,
    maxDuplication: 5,
    maxNewIssues: 0,
  };
  const number = (arg, value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) fail(`invalid number for ${arg}: ${value}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case '--base':
        opts.base = next();
        break;
      case '--all':
        opts.all = true;
        break;
      case '--gate':
        opts.gate = true;
        break;
      case '--format':
      case '-f':
        opts.format = next();
        break;
      case '--summary':
        opts.summary = true;
        break;
      case '--no-type-check':
        opts.typeCheck = false;
        break;
      case '--plugin-todo':
        opts.serverTodo = false;
        break;
      case '--cwd':
        opts.cwd = path.resolve(next());
        break;
      case '--sources':
        opts.sources = splitList(next());
        break;
      case '--exclusions':
        opts.exclusions = splitList(next());
        break;
      case '--coverage-exclusions':
        opts.coverageExclusions = splitList(next());
        break;
      case '--cpd-exclusions':
        opts.cpdExclusions = splitList(next());
        break;
      case '--lcov':
        opts.lcov = path.resolve(next());
        break;
      case '--no-coverage':
        opts.coverage = false;
        break;
      case '--min-coverage':
        opts.minCoverage = number(arg, next());
        break;
      case '--max-duplication':
        opts.maxDuplication = number(arg, next());
        break;
      case '--max-new-issues':
        opts.maxNewIssues = number(arg, next());
        break;
      case '-h':
      case '--help':
        console.log(
          [
            'Issue scan: sonar_scan.mjs [--base <branch> | --all | <paths...>] [--format <f>] [--summary]',
            'Quality gate: sonar_scan.mjs --gate [--base <branch>] [--lcov <file> | --no-coverage]',
            '  [--sources a,b] [--exclusions globs] [--coverage-exclusions globs] [--cpd-exclusions globs]',
            '  [--min-coverage 75] [--max-duplication 5] [--max-new-issues 0]',
            'Common: [--no-type-check] [--plugin-todo] [--cwd <dir>]',
          ].join('\n'),
        );
        process.exit(0);
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        opts.paths.push(arg);
    }
  }
  if (!FORMATS.includes(opts.format)) fail(`invalid format ${opts.format} (allowed: ${FORMATS.join(', ')})`);
  return opts;
}

// ---------- issue scan ----------

function changedFiles(root, baseOpt) {
  const base = resolveBase(root, baseOpt);
  const files = new Set();
  const add = (out) =>
    out
      ?.split('\n')
      .filter(Boolean)
      .forEach((f) => files.add(f));
  if (base) {
    const mergeBase = git(root, ['merge-base', 'HEAD', base]);
    if (!mergeBase) fail(`cannot find merge-base between HEAD and ${base}`);
    add(git(root, ['diff', '--name-only', '--diff-filter=d', `${mergeBase}...HEAD`]));
  }
  add(git(root, ['diff', '--name-only', '--diff-filter=d', 'HEAD']));
  add(git(root, ['ls-files', '--others', '--exclude-standard']));
  return { base, files: [...files] };
}

function printSummary(root, results) {
  const byRule = new Map();
  const byFile = [];
  let fatal = 0;
  for (const file of results) {
    const rel = path.relative(root, file.filePath);
    if (file.messages.length) byFile.push([rel, file.messages.length]);
    for (const m of file.messages) {
      if (m.fatal) fatal++;
      const key = m.ruleId ?? '(parse error)';
      const entry = byRule.get(key) ?? { count: 0, example: `${rel}:${m.line}:${m.column} ${m.message}` };
      entry.count++;
      byRule.set(key, entry);
    }
  }
  const total = [...byRule.values()].reduce((sum, e) => sum + e.count, 0);
  console.log(
    `\nTotal: ${total} issue(s) in ${byFile.length}/${results.length} file(s)${fatal ? `, ${fatal} parse error(s)` : ''}`,
  );
  if (!total) return;
  console.log('\nBy rule:');
  [...byRule.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([rule, e]) => console.log(`  ${String(e.count).padStart(4)}  ${rule}\n        e.g. ${e.example}`));
  console.log('\nBy file:');
  byFile.sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`));
}

function issueScan(root, opts) {
  let targets;
  let scope;
  if (opts.paths.length) {
    targets = opts.paths.map((p) => path.resolve(opts.cwd, p));
    targets.forEach((p) => existsSync(p) || fail(`path not found: ${p}`));
    scope = `paths: ${opts.paths.join(' ')}`;
  } else if (opts.all) {
    targets = [root];
    scope = 'whole project';
  } else {
    if (!git(root, ['rev-parse', '--git-dir'])) fail('not a git repo — pass --all or explicit paths');
    const { base, files } = changedFiles(root, opts.base);
    targets = files
      .filter((f) => isJsTs(f) && existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile())
      .map((f) => path.join(root, f));
    scope = base ? `changed vs ${base} + working tree` : 'working tree changes (no base branch found)';
    if (!targets.length) {
      console.log(`sonar-scan: no JS/TS files to scan (${scope}).`);
      return 0;
    }
  }

  const config = writeEslintConfig(root, opts);
  log(`root=${root} | scope=${scope} | targets=${targets.length} | type-aware rules=${config.useTypes ? 'on' : 'off'}`);
  try {
    if (!opts.summary) return runEslint(root, config.file, targets, { format: opts.format }).status;
    const { status, results, raw } = runEslint(root, config.file, targets, { capture: true });
    if (results) printSummary(root, results);
    else process.stdout.write(raw ?? '');
    return status;
  } finally {
    config.cleanup();
  }
}

// ---------- quality gate ----------

function toRanges(lines) {
  const out = [];
  for (const ln of lines) {
    const last = out.at(-1);
    if (last && ln === last[1] + 1) last[1] = ln;
    else out.push([ln, ln]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

function gateScope(root, opts) {
  const { minimatch } = requireFromSkill('minimatch');
  // Phạm vi giống sonar.sources / sonar.exclusions của server. Mặc định: src/ (nếu có), spec nằm trong sources.
  const props = readSonarProperties(root);
  const propSources = splitList(props['sonar.sources']);
  const defaultSources = existsSync(path.join(root, 'src')) ? ['src'] : ['.'];
  const sources = opts.sources ?? (propSources.length ? propSources : defaultSources);
  const exclusions = [...IGNORES, ...(opts.exclusions ?? splitList(props['sonar.exclusions']))];
  const coverageExclusions =
    opts.coverageExclusions ??
    (props['sonar.coverage.exclusions'] ? splitList(props['sonar.coverage.exclusions']) : DEFAULT_COVERAGE_EXCLUSIONS);
  const cpdExclusions = opts.cpdExclusions ?? splitList(props['sonar.cpd.exclusions']);
  const matches = (file, globs) => globs.some((g) => minimatch(file, g, { dot: true }));
  const inSources = (file) =>
    isJsTs(file) &&
    sources.some((s) => s === '.' || file === s || file.startsWith(`${s.replace(/\/+$/, '')}/`)) &&
    !matches(file, exclusions) &&
    existsSync(path.join(root, file));
  return { sources, coverageExclusions, cpdExclusions, matches, inSources };
}

function newIssuesCondition(root, opts, newFiles) {
  const config = writeEslintConfig(root, opts);
  const newIssues = [];
  try {
    const targets = [...newFiles.keys()].map((f) => path.join(root, f));
    if (targets.length) {
      const { results, raw } = runEslint(root, config.file, targets, { capture: true });
      if (!results) fail(`eslint failed:\n${raw}`);
      for (const result of results) {
        const rel = path.relative(root, result.filePath);
        const lines = newFiles.get(rel);
        for (const m of result.messages) {
          if (m.fatal || lines?.has(m.line)) newIssues.push({ file: rel, ...m });
        }
      }
    }
  } finally {
    config.cleanup();
  }
  return {
    name: 'New issues',
    value: `${newIssues.length}`,
    required: `<= ${opts.maxNewIssues}`,
    passed: newIssues.length <= opts.maxNewIssues,
    details: newIssues.map(
      (m) => `${m.file}:${m.line}:${m.column}  ${m.fatal ? 'PARSE ERROR' : m.ruleId}  ${m.message}`,
    ),
  };
}

async function coverageCondition(root, opts, newFiles, scope) {
  const { newCodeCoverage, parseLcov, runJestCoverage } = await import('./lib/coverage.mjs');
  let lcovFile = opts.lcov;
  let jest = null;
  if (lcovFile) {
    if (!existsSync(lcovFile)) fail(`lcov file not found: ${lcovFile}`);
  } else {
    jest = runJestCoverage(root);
    if (jest.error) fail(jest.error);
    lcovFile = jest.lcov;
    if (jest.testsFailed) log(`WARNING: tests failed — CI would fail before Sonar. ${jest.summary}\n${jest.output}`);
    else log(`tests: ${jest.summary}`);
    if (!lcovFile) fail('jest produced no lcov.info');
  }
  try {
    const coverageFiles = new Map([...newFiles].filter(([file]) => !scope.matches(file, scope.coverageExclusions)));
    const cov = newCodeCoverage(root, coverageFiles, parseLcov(lcovFile, root));
    const pct = cov.percent;
    return {
      name: 'Coverage on new code',
      value: pct === null ? 'n/a (no new lines to cover)' : `${pct.toFixed(1)}%`,
      required: `>= ${opts.minCoverage}%`,
      passed: pct === null || pct >= opts.minCoverage,
      note: `${cov.covered}/${cov.toCover} new lines to cover, ${cov.coveredConditions}/${cov.conditions} conditions`,
      details: cov.perFile
        .filter((f) => f.uncovered.length)
        .map(
          (f) =>
            `${f.file}: ${f.covered}/${f.toCover} lines, ${f.coveredConditions}/${f.conditions} conditions` +
            `${f.inLcov ? '' : ' (not in lcov → counted as uncovered)'} — uncovered: ${toRanges(f.uncovered)}`,
        ),
    };
  } finally {
    jest?.cleanup();
  }
}

async function duplicationCondition(root, opts, newFiles, newLineCount, scope) {
  const { detectDuplications } = await import('./lib/cpd.mjs');
  // CPD trên toàn bộ sources để bắt cả đoạn trùng với code cũ.
  const tracked = (git(root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n');
  const cpdFiles = tracked.filter((f) => f && scope.inSources(f) && !scope.matches(f, scope.cpdExclusions));
  const { duplicated, clones } = detectDuplications(root, cpdFiles);
  let dupLines = 0;
  for (const [file, lines] of newFiles) {
    const dup = duplicated.get(file);
    if (dup) for (const ln of lines) if (dup.has(ln)) dupLines++;
  }
  const pct = newLineCount ? (dupLines / newLineCount) * 100 : 0;
  const touchesNew = (part) => {
    const lines = newFiles.get(part.file);
    if (!lines) return false;
    for (let ln = part.start; ln <= part.end; ln++) if (lines.has(ln)) return true;
    return false;
  };
  return {
    name: 'Duplicated lines on new code',
    value: `${pct.toFixed(2)}%`,
    required: `<= ${opts.maxDuplication}%`,
    passed: pct <= opts.maxDuplication,
    note: `${dupLines}/${newLineCount} new lines duplicated`,
    details: clones
      .filter((c) => touchesNew(c.a) || touchesNew(c.b))
      .map(
        (c) => `${c.a.file}:${c.a.start}-${c.a.end}  <->  ${c.b.file}:${c.b.start}-${c.b.end}  (${c.tokens} tokens)`,
      ),
  };
}

async function qualityGate(root, opts) {
  const { collectNewLines } = await import('./lib/newcode.mjs');
  if (!git(root, ['rev-parse', '--git-dir'])) fail('--gate needs a git repo');
  const base = resolveBase(root, opts.base);
  if (!base) fail('no base branch found — pass --base <branch>');

  const scope = gateScope(root, opts);
  const { mergeBase, files: allNew } = collectNewLines(root, base);
  const newFiles = new Map([...allNew].filter(([file]) => scope.inSources(file)));
  const newLineCount = [...newFiles.values()].reduce((sum, set) => sum + set.size, 0);
  log(
    `base=${base} (merge-base ${mergeBase.slice(0, 8)}) | sources=${scope.sources.join(',')} | ` +
      `new files=${newFiles.size} | new lines=${newLineCount}`,
  );

  const conditions = [newIssuesCondition(root, opts, newFiles)];
  if (opts.coverage) conditions.push(await coverageCondition(root, opts, newFiles, scope));
  conditions.push(await duplicationCondition(root, opts, newFiles, newLineCount, scope));

  const failed = conditions.filter((c) => !c.passed);
  console.log(`\nQuality Gate (local estimate) — new code vs ${base}, ${newLineCount} new lines`);
  for (const c of conditions) {
    const note = c.note ? ` — ${c.note}` : '';
    console.log(`\n${c.passed ? 'PASS' : 'FAIL'}  ${c.name}: ${c.value} (required ${c.required})${note}`);
    for (const d of c.details) console.log(`        ${d}`);
  }
  if (!opts.coverage) console.log('\nSKIP  Coverage on new code (--no-coverage)');
  console.log(`\nResult: ${failed.length ? `FAILED (${failed.length} condition(s))` : 'PASSED'}`);
  return failed.length ? 1 : 0;
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(opts.cwd)) fail(`directory not found: ${opts.cwd}`);
const root = git(opts.cwd, ['rev-parse', '--show-toplevel']) ?? opts.cwd;
ensureDeps();
process.exitCode = opts.gate ? await qualityGate(root, opts) : issueScan(root, opts);
