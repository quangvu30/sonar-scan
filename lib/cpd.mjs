import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseSource, walk } from './coverage.mjs';

// Mô phỏng CPD của SonarQube cho JS/TS:
// - Token lấy từ parser, bỏ token thuộc câu import, string/template literal -> "LITERAL".
// - Gom token theo dòng; block = 10 dòng có token liên tiếp (sonar.cpd block size mặc định).
// - Clone = chuỗi block trùng liên tiếp dài nhất, giữ lại nếu >= 100 token.
// - Dòng trùng = từ dòng đầu đến dòng cuối của clone, tính cho cả 2 phía.
const BLOCK_LINES = 10;
const MIN_TOKENS = 100;

function tokenLines(file) {
  let ast;
  try {
    ast = parseSource(file);
  } catch {
    return [];
  }
  const importRanges = [];
  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration') importRanges.push(node.range);
  });
  const isImport = (range) => importRanges.some(([s, e]) => range[0] >= s && range[1] <= e);

  const byLine = new Map();
  for (const token of ast.tokens ?? []) {
    if (isImport(token.range)) continue;
    const image = token.type === 'String' || token.type === 'Template' ? 'LITERAL' : token.value;
    const line = token.loc.start.line;
    const entry = byLine.get(line) ?? { line, images: [] };
    entry.images.push(image);
    byLine.set(line, entry);
  }
  return [...byLine.values()]
    .sort((a, b) => a.line - b.line)
    .map((e) => ({ line: e.line, tokens: e.images.length, hash: e.images.join('\u0001') }));
}

function blockHash(lines, i) {
  const h = createHash('sha1');
  for (let k = 0; k < BLOCK_LINES; k++) h.update(lines[i + k].hash).update('\u0000');
  return h.digest('base64');
}

export function detectDuplications(root, files) {
  const units = files.map((file) => ({ file, lines: tokenLines(path.join(root, file)) }));
  const blocks = new Map();
  units.forEach((unit, u) => {
    unit.hashes = [];
    for (let i = 0; i + BLOCK_LINES <= unit.lines.length; i++) {
      const hash = blockHash(unit.lines, i);
      unit.hashes.push(hash);
      const list = blocks.get(hash) ?? [];
      list.push([u, i]);
      blocks.set(hash, list);
    }
  });

  const duplicated = new Map();
  const clones = [];
  const markLines = (unit, from, to) => {
    const set = duplicated.get(unit.file) ?? new Set();
    for (let ln = unit.lines[from].line; ln <= unit.lines[to].line; ln++) set.add(ln);
    duplicated.set(unit.file, set);
  };

  for (const occurrences of blocks.values()) {
    if (occurrences.length < 2) continue;
    for (let a = 0; a < occurrences.length; a++) {
      for (let b = a + 1; b < occurrences.length; b++) {
        const [ua, ia] = occurrences[a];
        const [ub, ib] = occurrences[b];
        const A = units[ua];
        const B = units[ub];
        // Chỉ bắt đầu clone ở block đầu tiên của chuỗi trùng (block trước đó không trùng).
        if (ia > 0 && ib > 0 && A.hashes[ia - 1] === B.hashes[ib - 1]) continue;
        let len = 1;
        while (ia + len < A.hashes.length && ib + len < B.hashes.length && A.hashes[ia + len] === B.hashes[ib + len]) {
          len++;
        }
        const endA = ia + len + BLOCK_LINES - 2;
        const endB = ib + len + BLOCK_LINES - 2;
        // Bỏ clone tự chồng lên chính nó trong cùng file.
        if (ua === ub && ib <= endA) continue;
        let tokens = 0;
        for (let k = ia; k <= endA; k++) tokens += A.lines[k].tokens;
        if (tokens < MIN_TOKENS) continue;
        markLines(A, ia, endA);
        markLines(B, ib, endB);
        clones.push({
          a: { file: A.file, start: A.lines[ia].line, end: A.lines[endA].line },
          b: { file: B.file, start: B.lines[ib].line, end: B.lines[endB].line },
          tokens,
        });
      }
    }
  }
  return { duplicated, clones };
}
