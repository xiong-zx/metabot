#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

export function checkDownstreamBoundaries(repoRoot, manifestPath = 'config/downstream-features.json', options = {}) {
  const root = path.resolve(repoRoot);
  const manifest = JSON.parse(fs.readFileSync(resolveInside(root, manifestPath), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.features) ||
    !Array.isArray(manifest.forbiddenPaths) ||
    (manifest.reverseBoundaries !== undefined && !Array.isArray(manifest.reverseBoundaries))
  ) {
    throw new Error('Unsupported downstream feature manifest');
  }

  const failures = [];
  const checkedFeatures = [];
  for (const forbiddenPath of manifest.forbiddenPaths) {
    if (pathEntryExists(resolveInside(root, forbiddenPath))) failures.push(`forbidden path exists: ${forbiddenPath}`);
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
    if (feature.status === 'required' && roots.length === 0) {
      failures.push(`${feature.id}: required feature must declare non-empty roots`);
    }
    if (roots.some((item) => typeof item !== 'string' || item.trim() === '')) {
      failures.push(`${feature.id}: roots must contain non-empty relative paths`);
      checkedFeatures.push({ id: feature.id, status: feature.status, presentRoots: 0 });
      continue;
    }
    const existingRoots = roots.filter((item) => pathEntryExists(resolveInside(root, item)));
    assertSourceRootsAreNotSymlinks(root, existingRoots);
    if (feature.status === 'required' && existingRoots.length !== roots.length) {
      const missing = roots.filter((item) => !existingRoots.includes(item));
      failures.push(`${feature.id}: missing required roots: ${missing.join(', ')}`);
    }
    const thinHooks = feature.thinHooks;
    const allowedImporters = feature.allowedImporters;
    if (thinHooks !== undefined) {
      if (!Array.isArray(thinHooks) || thinHooks.some((item) => typeof item !== 'string' || item.trim() === '')) {
        failures.push(`${feature.id}: thinHooks must contain non-empty relative paths`);
      } else {
        const missingHooks = thinHooks.filter((item) => !pathEntryExists(resolveInside(root, item)));
        if (missingHooks.length > 0) failures.push(`${feature.id}: missing thinHooks: ${missingHooks.join(', ')}`);
        const ownedHooks = thinHooks.filter((item) => roots.some((featureRoot) => containsPath(featureRoot, item)));
        if (ownedHooks.length > 0) failures.push(`${feature.id}: thinHooks must remain outside owned roots: ${ownedHooks.join(', ')}`);
      }
    }
    if (allowedImporters !== undefined) {
      if (!Array.isArray(allowedImporters) || allowedImporters.some((item) => typeof item !== 'string' || item.trim() === '')) {
        failures.push(`${feature.id}: allowedImporters must contain non-empty relative paths`);
      } else {
        const missingImporters = allowedImporters.filter((item) => !pathEntryExists(resolveInside(root, item)));
        if (missingImporters.length > 0) failures.push(`${feature.id}: missing allowedImporters: ${missingImporters.join(', ')}`);
        const undeclared = allowedImporters.filter((item) => !Array.isArray(thinHooks) || !thinHooks.includes(item));
        if (undeclared.length > 0) failures.push(`${feature.id}: allowedImporters must also be declared thinHooks: ${undeclared.join(', ')}`);
      }
    }
    const importRoots = feature.importRoots ?? roots;
    if (!Array.isArray(importRoots) || importRoots.some((item) => typeof item !== 'string' || item.trim() === '')) {
      failures.push(`${feature.id}: importRoots must contain non-empty relative paths`);
    } else if (importRoots.some((item) => !roots.some((featureRoot) => containsPath(featureRoot, item)))) {
      failures.push(`${feature.id}: importRoots must stay within declared roots`);
    } else {
      const existingImportRoots = importRoots.filter((item) => pathEntryExists(resolveInside(root, item)));
      assertSourceRootsAreNotSymlinks(root, existingImportRoots);
      if (feature.status === 'required' && existingImportRoots.length !== importRoots.length) {
        const missing = importRoots.filter((item) => !existingImportRoots.includes(item));
        failures.push(`${feature.id}: missing required importRoots: ${missing.join(', ')}`);
      }
      if (existingImportRoots.length > 0 && Array.isArray(feature.forbiddenImports)) {
        scanForbiddenImports(root, feature.id, existingImportRoots, feature.forbiddenImports, failures);
      }
    }
    checkedFeatures.push({ id: feature.id, status: feature.status, presentRoots: existingRoots.length });
  }

  const checkedReverseBoundaries = [];
  for (const boundary of manifest.reverseBoundaries ?? []) {
    if (!boundary || typeof boundary.id !== 'string') {
      failures.push('reverse boundary entries require an id');
      continue;
    }
    if (
      !Array.isArray(boundary.roots) ||
      boundary.roots.length === 0 ||
      boundary.roots.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      failures.push(`${boundary.id}: reverse boundary must declare non-empty roots`);
      continue;
    }
    const existingRoots = boundary.roots.filter((item) => pathEntryExists(resolveInside(root, item)));
    assertSourceRootsAreNotSymlinks(root, existingRoots);
    if (existingRoots.length !== boundary.roots.length) {
      const missing = boundary.roots.filter((item) => !existingRoots.includes(item));
      failures.push(`${boundary.id}: missing reverse-boundary roots: ${missing.join(', ')}`);
    }
    if (!Array.isArray(boundary.forbiddenImports) || boundary.forbiddenImports.length === 0) {
      failures.push(`${boundary.id}: reverse boundary must declare forbidden imports`);
    } else if (existingRoots.length > 0) {
      const allowedImporters = Array.isArray(boundary.allowedImporters)
        ? boundary.allowedImporters.map((item) => resolveInside(root, item))
        : [];
      scanForbiddenImports(root, boundary.id, existingRoots, boundary.forbiddenImports, failures, allowedImporters);
    }
    checkedReverseBoundaries.push({ id: boundary.id, presentRoots: existingRoots.length });
  }

  return { ok: failures.length === 0, failures, checkedFeatures, checkedReverseBoundaries };
}

function assertSourceRootsAreNotSymlinks(root, sourceRoots) {
  for (const sourceRoot of sourceRoots) {
    const resolvedRoot = resolveInside(root, sourceRoot);
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
      throw new Error(`source root cannot be a symlink: ${resolvedRoot}`);
    }
  }
}

function scanForbiddenImports(root, boundaryId, sourceRoots, forbiddenImports, failures, allowedImporters = []) {
  if (forbiddenImports.some((item) => typeof item !== 'string' || item.trim() === '')) {
    failures.push(`${boundaryId}: forbiddenImports must contain non-empty strings`);
    return;
  }
  for (const sourceRoot of sourceRoots) {
    for (const file of walkSourceFiles(resolveInside(root, sourceRoot))) {
      if (allowedImporters.some((allowed) => file === allowed || file.startsWith(`${allowed}${path.sep}`))) continue;
      for (const specifier of collectModuleSpecifiers(file)) {
        const forbidden = forbiddenImports.find((item) => matchesForbiddenImport(root, file, specifier, item));
        if (forbidden) failures.push(`${boundaryId}: ${relative(root, file)} imports forbidden '${specifier}'`);
      }
    }
  }
}

function matchesForbiddenImport(root, importingFile, specifier, forbiddenImport) {
  if (isPackageBoundary(forbiddenImport)) {
    return isBareSpecifier(specifier) && (specifier === forbiddenImport || specifier.startsWith(`${forbiddenImport}/`));
  }
  if (!isRelativeSpecifier(specifier)) return false;

  const resolvedImport = stripSourceExtension(path.resolve(path.dirname(importingFile), specifier));
  const resolvedBoundary = stripSourceExtension(resolveInside(root, forbiddenImport));
  return resolvedImport === resolvedBoundary || resolvedImport.startsWith(`${resolvedBoundary}${path.sep}`);
}

function isPackageBoundary(forbiddenImport) {
  return forbiddenImport.startsWith('@') || !forbiddenImport.includes('/');
}

function isBareSpecifier(specifier) {
  return !isRelativeSpecifier(specifier) && !path.isAbsolute(specifier);
}

function isRelativeSpecifier(specifier) {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function stripSourceExtension(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file)) ? file.slice(0, -path.extname(file).length) : file;
}

function containsPath(parent, child) {
  const normalizedParent = path.normalize(parent);
  const normalizedChild = path.normalize(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      return false;
    }
    throw error;
  }
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
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
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
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || path.isAbsolute(relativePath)) {
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
  else if (result.ok) {
    process.stdout.write(
      `Downstream boundaries OK (${result.checkedFeatures.length} features, ${result.checkedReverseBoundaries.length} reverse boundaries)\n`,
    );
  } else process.stderr.write(`${result.failures.join('\n')}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
