import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const requireFromSkill = createRequire(path.join(SKILL_DIR, 'package.json'));

export const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export const DEFAULT_BASES = ['dev', 'develop', 'main', 'master'];
export const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/out/**',
  '**/*.min.js',
  '**/*.d.ts',
];

export function fail(message) {
  console.error(`sonar-scan: ${message}`);
  process.exit(2);
}

export function log(message) {
  console.error(`sonar-scan: ${message}`);
}

export function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.replace(/\n$/, '') : null;
}

export function isJsTs(file) {
  return JS_TS_EXTENSIONS.includes(path.extname(file)) && !file.endsWith('.d.ts');
}

export function ensureDeps() {
  const required = ['eslint-plugin-sonarjs', 'eslint', '@typescript-eslint/parser', 'typescript', 'minimatch'];
  if (required.every((dep) => existsSync(path.join(SKILL_DIR, 'node_modules', dep)))) return;
  log('installing dependencies into the skill directory (first run)...');
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: SKILL_DIR, stdio: 'inherit' });
  if (result.status !== 0) fail('npm install failed');
}

// Ưu tiên branch local, không có thì dùng origin/<name>.
export function resolveRef(root, name) {
  for (const ref of [name, `origin/${name}`]) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}

export function detectBase(root) {
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  for (const name of DEFAULT_BASES) {
    if (name === current) continue;
    const ref = resolveRef(root, name);
    if (ref) return ref;
  }
  return null;
}

export function resolveBase(root, baseOpt) {
  if (!baseOpt) return detectBase(root);
  const ref = resolveRef(root, baseOpt);
  if (!ref) fail(`base branch not found locally or on origin: ${baseOpt}`);
  return ref;
}

// Đọc sonar-project.properties (nếu có) để lấy sources/exclusions giống server.
export function readSonarProperties(root) {
  const file = path.join(root, 'sonar-project.properties');
  if (!existsSync(file)) return {};
  const props = {};
  let pending = '';
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = pending + raw.trim();
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = '';
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const idx = line.search(/[=:]/);
    if (idx > 0) props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return props;
}

export function splitList(value) {
  return value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}
