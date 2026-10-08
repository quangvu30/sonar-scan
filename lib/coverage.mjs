import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { log, requireFromSkill } from './common.mjs';

// Node mà SonarJS tính là "executable line" (dòng bắt đầu của statement). File
// không có trong lcov thì SonarQube coi các dòng này là chưa cover.
const EXECUTABLE_NODES = new Set([
  'ExpressionStatement',
  'IfStatement',
  'LabeledStatement',
  'BreakStatement',
  'ContinueStatement',
  'WithStatement',
  'SwitchStatement',
  'ReturnStatement',
  'ThrowStatement',
  'TryStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'DebuggerStatement',
  'VariableDeclaration',
]);

export function parseSource(file) {
  const { parse } = requireFromSkill('@typescript-eslint/parser');
  return parse(readFileSync(file, 'utf8'), {
    loc: true,
    range: true,
    tokens: true,
    comment: false,
    jsx: /\.[jt]sx$/.test(file),
  });
}

export function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function executableLines(file) {
  const lines = new Set();
  walk(parseSource(file), (node) => {
    if (EXECUTABLE_NODES.has(node.type)) lines.add(node.loc.start.line);
  });
  return lines;
}

function hasJest(root) {
  const pkgFile = path.join(root, 'package.json');
  if (!existsSync(pkgFile)) return false;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(
    pkg.jest ||
    deps.jest ||
    ['js', 'ts', 'cjs', 'mjs', 'json'].some((ext) => existsSync(path.join(root, `jest.config.${ext}`))),
  );
}

// Chạy test bằng jest của chính project (giữ collectCoverageFrom của project, đúng như CI),
// chỉ đổi reporter/thư mục output sang temp để không ghi đè coverage/ của project.
export function runJestCoverage(root) {
  if (!hasJest(root)) return { error: 'project has no jest setup — pass --lcov <path> or --no-coverage' };
  const dir = mkdtempSync(path.join(tmpdir(), 'sonar-cov-'));
  log('running jest --coverage --runInBand (this may take a while)...');
  const result = spawnSync(
    'npx',
    ['--no-install', 'jest', '--coverage', '--runInBand', '--coverageReporters=lcov', `--coverageDirectory=${dir}`],
    { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  const lcov = path.join(dir, 'lcov.info');
  const summary = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split('\n')
    .filter((l) => /^(Tests|Test Suites):/.test(l.trim()))
    .join(' | ');
  return {
    lcov: existsSync(lcov) ? lcov : null,
    testsFailed: result.status !== 0,
    summary,
    output: result.status !== 0 ? `${result.stdout}\n${result.stderr}`.split('\n').slice(-40).join('\n') : '',
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function parseLcov(lcovFile, root) {
  const files = new Map();
  let current = null;
  for (const raw of readFileSync(lcovFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const sf = line.slice(3);
      current = { lines: new Map(), branches: new Map() };
      files.set(path.relative(root, path.resolve(root, sf)), current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      current.lines.set(Number(ln), Number(hits));
    } else if (line.startsWith('BRDA:')) {
      const [ln, , , taken] = line.slice(5).split(',');
      const list = current.branches.get(Number(ln)) ?? [];
      list.push(taken === '-' ? 0 : Number(taken));
      current.branches.set(Number(ln), list);
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

// Công thức SonarQube: (dòng đã cover + condition đã cover) / (dòng cần cover + tổng condition),
// chỉ tính trên dòng mới. File có trong lcov dùng DA/BRDA; file không có trong lcov
// thì mọi executable line mới đều tính là chưa cover.
export function newCodeCoverage(root, newFiles, lcovFiles) {
  const perFile = [];
  for (const [file, newLines] of newFiles) {
    const entry = lcovFiles.get(file);
    let toCover = 0;
    let covered = 0;
    let conditions = 0;
    let coveredConditions = 0;
    const uncovered = [];
    if (entry) {
      for (const [ln, hits] of entry.lines) {
        if (!newLines.has(ln)) continue;
        toCover++;
        if (hits > 0) covered++;
        else uncovered.push(ln);
      }
      for (const [ln, takenList] of entry.branches) {
        if (!newLines.has(ln)) continue;
        conditions += takenList.length;
        const hit = takenList.filter((t) => t > 0).length;
        coveredConditions += hit;
        if (hit < takenList.length && !uncovered.includes(ln)) uncovered.push(ln);
      }
    } else {
      for (const ln of executableLines(path.join(root, file))) {
        if (!newLines.has(ln)) continue;
        toCover++;
        uncovered.push(ln);
      }
    }
    if (toCover || conditions) {
      perFile.push({
        file,
        inLcov: Boolean(entry),
        toCover,
        covered,
        conditions,
        coveredConditions,
        uncovered: uncovered.sort((a, b) => a - b),
      });
    }
  }
  const sum = (key) => perFile.reduce((acc, f) => acc + f[key], 0);
  const toCover = sum('toCover');
  const conditions = sum('conditions');
  const hit = sum('covered') + sum('coveredConditions');
  const denominator = toCover + conditions;
  return {
    percent: denominator ? (hit / denominator) * 100 : null,
    toCover,
    covered: sum('covered'),
    conditions,
    coveredConditions: sum('coveredConditions'),
    perFile,
  };
}
