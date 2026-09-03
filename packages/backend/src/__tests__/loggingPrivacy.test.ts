import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ts: typeof import('typescript') = createRequire(import.meta.url)('typescript');
const backendRoot = path.resolve(__dirname, '../..');
const dangerousProperties = new Set([
  'cause',
  'detail',
  'err',
  'error',
  'message',
  'parameters',
  'query',
  'stack',
]);
const logMethods = new Set(['debug', 'error', 'fatal', 'info', 'trace', 'warn']);

function productionTypeScript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules'
        ? []
        : productionTypeScript(absolute);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

function propertyName(node: import('typescript').PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function rawErrorReferences(node: import('typescript').Node): string[] {
  const violations: string[] = [];
  const visit = (candidate: import('typescript').Node): void => {
    if (
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      dangerousProperties.has(propertyName(candidate.name) ?? '')
    ) {
      violations.push(`property '${propertyName(candidate.name)}'`);
    }
    if (
      ts.isPropertyAccessExpression(candidate) &&
      dangerousProperties.has(candidate.name.text)
    ) {
      violations.push(`member '.${candidate.name.text}'`);
    }
    if (ts.isIdentifier(candidate) && candidate.text === 'error') {
      violations.push("identifier 'error'");
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return violations;
}

function inspectLoggerCalls(file: string): { calls: number; violations: string[] } {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let calls = 0;
  const violations: string[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'logger' &&
      logMethods.has(node.expression.name.text)
    ) {
      calls += 1;
      for (const argument of node.arguments) {
        for (const problem of rawErrorReferences(argument)) {
          const position = source.getLineAndCharacterOfPosition(argument.getStart(source));
          violations.push(
            `${path.relative(backendRoot, file)}:${position.line + 1} logs raw ${problem}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, violations };
}

describe('backend log privacy', () => {
  it('never hands a raw error, message, stack, query or parameters to the logger', () => {
    const files = [
      path.join(backendRoot, 'server.ts'),
      ...productionTypeScript(path.join(backendRoot, 'scripts')),
      ...productionTypeScript(path.join(backendRoot, 'src')),
    ];
    const evidence = files.map(inspectLoggerCalls);

    expect(evidence.reduce((total, file) => total + file.calls, 0)).toBeGreaterThanOrEqual(20);
    expect(evidence.flatMap((file) => file.violations)).toEqual([]);
  });
});
