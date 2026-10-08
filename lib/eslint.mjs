import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IGNORES, SKILL_DIR, requireFromSkill } from './common.mjs';

// Plugin mà comment eslint-disable trong project hay trỏ tới nhưng không load ở
// đây -> stub để ESLint không báo "Definition for rule ... was not found".
const STUB_PLUGINS = [
  '@typescript-eslint',
  'prettier',
  'import',
  'react',
  'react-hooks',
  'jsx-a11y',
  'jest',
  'vue',
  'n',
  'node',
  'unicorn',
  'promise',
  'security',
  '@next/next',
  '@angular-eslint',
];

export function writeEslintConfig(root, { typeCheck, serverTodo }) {
  const sonarjsPath = requireFromSkill.resolve('eslint-plugin-sonarjs');
  const tsParserPath = requireFromSkill.resolve('@typescript-eslint/parser');
  const serverRulesPath = path.join(SKILL_DIR, 'lib', 'server-rules.cjs');
  const useTypes = typeCheck && existsSync(path.join(root, 'tsconfig.json'));
  const tsParserOptions = useTypes ? { projectService: true, tsconfigRootDir: root } : {};

  const content = `
const sonarjs = require(${JSON.stringify(sonarjsPath)});
const tsParser = require(${JSON.stringify(tsParserPath)});
const serverRules = require(${JSON.stringify(serverRulesPath)});
const basePath = ${JSON.stringify(root)};
const rules = { ...sonarjs.configs.recommended.rules };
if (${JSON.stringify(serverTodo)}) {
  // SonarQube server (bản đang dùng) báo mọi TODO, kể cả TODO(ABC-123) mà plugin v4 bỏ qua.
  rules['sonarjs/todo-tag'] = 'off';
  rules['sonar-server/todo-tag'] = 'error';
}
const noopRule = { create: () => ({}) };
const stubPlugin = { rules: new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? noopRule : undefined) }) };
const stubPlugins = Object.fromEntries(${JSON.stringify(STUB_PLUGINS)}.map((name) => [name, stubPlugin]));
const plugins = { sonarjs, 'sonar-server': serverRules };
module.exports = [
  { basePath, plugins: stubPlugins, linterOptions: { reportUnusedDisableDirectives: 'off' } },
  { basePath, ignores: ${JSON.stringify(IGNORES)} },
  {
    basePath,
    files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins,
    rules,
  },
  {
    basePath,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: { parser: tsParser, parserOptions: ${JSON.stringify(tsParserOptions)} },
    plugins,
    rules,
  },
];
`;
  const dir = mkdtempSync(path.join(tmpdir(), 'sonar-scan-'));
  const file = path.join(dir, 'eslint.config.cjs');
  writeFileSync(file, content);
  return { file, useTypes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// capture=true: trả JSON kết quả; ngược lại in thẳng ra terminal.
export function runEslint(root, configFile, targets, { format = 'stylish', capture = false } = {}) {
  const eslintBin = path.join(SKILL_DIR, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const args = [
    eslintBin,
    '--no-config-lookup',
    '-c',
    configFile,
    '--no-warn-ignored',
    '-f',
    capture ? 'json' : format,
  ];
  const result = spawnSync(process.execPath, [...args, ...targets], {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (!capture) return { status: result.status ?? 2 };
  const ok = result.status === 0 || result.status === 1;
  return { status: result.status ?? 2, results: ok ? JSON.parse(result.stdout) : null, raw: result.stdout };
}
