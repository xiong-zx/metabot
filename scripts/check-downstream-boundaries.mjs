#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

export function checkDownstreamBoundaries(repoRoot, manifestPath = 'config/downstream-features.json', options = {}) {
  const root = path.resolve(repoRoot);
  const manifest = JSON.parse(fs.readFileSync(resolveInside(root, manifestPath), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.features) || !Array.isArray(manifest.forbiddenPaths)) {
    throw new Error('Unsupported downstream feature manifest');
  }

  const failures = [];
  const checkedFeatures = [];
  for (const forbiddenPath of manifest.forbiddenPaths) {
    if (fs.existsSync(resolveInside(root, forbiddenPath))) failures.push(`forbidden path exists: ${forbiddenPath}`);
  }

  for (const feature of manifest.features) {
    if (!feature || typeof feature.id !== 'string' || !['required', 'planned'].includes(feature.status)) {
      failures.push('feature entries require id and required|planned status');
      continue;
    }
    if (options.release && feature.status === 'planned') {
      failures.push(`${feature.id}: planned feature is not allowed in release mode`);
    }
    const roots = Array.isArray(feature.roots) ? feature.roots : [];
    const existingRoots = roots.filter((item) => fs.existsSync(resolveInside(root, item)));
    for (const sourceRoot of existingRoots) {
      const resolvedRoot = resolveInside(root, sourceRoot);
      if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
        throw new Error(`source root cannot be a symlink: ${resolvedRoot}`);
      }
    }
    if (feature.status === 'required' && existingRoots.length !== roots.length) {
      const missing = roots.filter((item) => !existingRoots.includes(item));
      failures.push(`${feature.id}: missing required roots: ${missing.join(', ')}`);
    }
    if (existingRoots.length > 0 && Array.isArray(feature.forbiddenImports)) {
      for (const sourceRoot of existingRoots) {
        for (const file of walkSourceFiles(resolveInside(root, sourceRoot))) {
          for (const specifier of collectModuleSpecifiers(file)) {
            const forbidden = feature.forbiddenImports.find(
              (item) => specifier === item || specifier.startsWith(`${item}/`) || specifier.includes(item),
            );
            if (forbidden) failures.push(`${feature.id}: ${relative(root, file)} imports forbidden '${specifier}'`);
          }
        }
      }
    }
    checkedFeatures.push({ id: feature.id, status: feature.status, presentRoots: existingRoots.length });
  }
  return { ok: failures.length === 0, failures, checkedFeatures };
}

function collectModuleSpecifiers(file) {
  const source = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
}

function walkSourceFiles(entry) {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink()) throw new Error(`source root cannot be a symlink: ${entry}`);
  if (stat.isFile()) return SOURCE_EXTENSIONS.has(path.extname(entry)) ? [entry] : [];
  const files = [];
  for (const name of fs.readdirSync(entry).sort()) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
    const child = path.join(entry, name);
    const childStat = fs.lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`source tree cannot contain a symlink: ${child}`);
    if (childStat.isDirectory()) files.push(...walkSourceFiles(child));
    else if (SOURCE_EXTENSIONS.has(path.extname(child))) files.push(child);
  }
  return files;
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error(`manifest path must be relative: ${String(relativePath)}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`manifest path escapes repository: ${relativePath}`);
  }
  return resolved;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const release = args.includes('--release');
  const rootArg = args.find((arg) => !arg.startsWith('-'));
  const result = checkDownstreamBoundaries(rootArg ?? process.cwd(), undefined, { release });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) process.stdout.write(`Downstream boundaries OK (${result.checkedFeatures.length} features)\n`);
  else process.stderr.write(`${result.failures.join('\n')}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
