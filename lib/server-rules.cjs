const { builtinModules } = require('node:module');

// Rule mô phỏng hành vi SonarQube server khi khác plugin eslint-plugin-sonarjs.

// S1135 bản server: báo mọi "TODO" (không phân biệt hoa thường, không nằm giữa
// chữ cái) trong comment, kể cả TODO(ABC-123) — plugin v4 bỏ qua TODO có mã Jira.
const LETTER = /\p{Letter}/u;

const todoTag = {
  meta: {
    type: 'suggestion',
    messages: { completeTODO: 'Complete the task associated to this "TODO" comment.' },
    schema: [],
  },
  create(context) {
    return {
      'Program:exit'() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.value.trim().startsWith('eslint-disable')) continue;
          const lines = comment.value.split(/\r\n?|\n/);
          lines.forEach((text, idx) => {
            const lower = text.toLowerCase();
            let from = 0;
            while (from < lower.length) {
              const at = lower.indexOf('todo', from);
              if (at < 0) break;
              const before = lower[at - 1];
              const after = lower[at + 4];
              if (!(before && LETTER.test(before)) && !(after && LETTER.test(after))) {
                const line = comment.loc.start.line + idx;
                // Dòng đầu cộng thêm độ dài "//" hoặc "/*".
                const column = (idx === 0 ? comment.loc.start.column + 2 : 0) + at;
                context.report({
                  messageId: 'completeTODO',
                  loc: { start: { line, column }, end: { line, column: column + 4 } },
                });
                break;
              }
              from = at + 4;
            }
          });
        }
      },
    };
  },
};

// S7772 (typescript:S7772 / javascript:S7772): import module built-in của Node phải
// có tiền tố "node:" (`crypto` -> `node:crypto`). Tương đương unicorn/prefer-node-protocol.
// Server báo cả ở ESM import/export-from, require('x') và import('x').
const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));

const preferNodeProtocol = {
  meta: {
    type: 'suggestion',
    messages: { prefer: 'Prefer `node:{{name}}` over `{{name}}`.' },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return;
      if (!NODE_BUILTINS.has(node.value)) return;
      context.report({ node, messageId: 'prefer', data: { name: node.value } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
          check(node.arguments[0]);
        }
      },
    };
  },
};

module.exports = { rules: { 'todo-tag': todoTag, 'prefer-node-protocol': preferNodeProtocol } };
