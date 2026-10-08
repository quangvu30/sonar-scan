import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fail, git } from './common.mjs';

// "New code" giống PR analysis của SonarQube: các dòng thêm/sửa so với
// merge-base với branch đích. Lấy cả thay đổi chưa commit và file untracked
// để quét được trước khi push.
export function collectNewLines(root, baseRef) {
  const mergeBase = git(root, ['merge-base', 'HEAD', baseRef]);
  if (!mergeBase) fail(`cannot find merge-base between HEAD and ${baseRef}`);

  const files = new Map();
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=d', mergeBase]) ?? '';
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target.startsWith('b/') ? target.slice(2) : null;
    } else if (line.startsWith('@@') && current) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (!files.has(current)) files.set(current, new Set());
      for (let i = start; i < start + count; i++) files.get(current).add(i);
    }
  }

  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
  for (const file of untracked.split('\n').filter(Boolean)) {
    const full = path.join(root, file);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    const count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
    files.set(file, new Set(Array.from({ length: count }, (_, i) => i + 1)));
  }

  return { mergeBase, files };
}
