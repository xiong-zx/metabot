import { execFileSync } from 'node:child_process';
import process from 'node:process';
import ts from 'typescript';

export const MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERN =
  /^(?:src|tests|packages)\/.*(?:memory-core|research-memory|autoresearchclaw|worker-manager).*\.ts$/;

export const MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERNS = [
  MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERN,
  /^src\/api\/routes\/(?:research-memory-routes|task-routes|worker-routes)\.ts$/,
  /^src\/mcp\/(?:research-memory-mcp-tools|worker-manager-mcp)\.ts$/,
  /^tests\/(?:research-memory|memory-core|worker-dispatch|worker-manager|task-routes).*\.test\.ts$/,
] as const;

export const MEMORY_CORE_FORBIDDEN_LEXICAL_PATTERNS = [
  {
    id: 'legacy-autoresearchclaw-candidate-alias',
    pattern: /\b(?:hypothesis_candidates|finding_candidates|decision_candidates)\b/,
  },
] as const;

export interface SourceInventory {
  declarationSymbols: string[];
  diagnostics: string[];
  exportedDeclarationSymbols: string[];
  importSpecifiers: string[];
  testNames: string[];
}

export interface ParentMergeHygieneResult {
  changedPaths: string[];
  diagnostics: string[];
  missingExportedDeclarationSymbols: string[];
  missingDeclarationSymbols: string[];
  missingImportSpecifiers: string[];
  missingTestNames: string[];
  parentRef: string;
}

export interface MemoryCoreMergeHygieneReport {
  checked: boolean;
  mergeRef: string;
  ok: boolean;
  parentResults: ParentMergeHygieneResult[];
  skippedReason?: string;
}

export interface MergeHygieneGitReader {
  listChangedFiles(parentRef: string, mergeRef: string): string[];
  readFileAtRef(ref: string, filePath: string): string | undefined;
  resolveParentRefs(ref: string): string[];
}

export interface RunMergeHygieneOptions {
  cwd?: string;
  git?: MergeHygieneGitReader;
  mergeRef?: string;
}

export function isMemoryCoreMergeHygienePath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function selectMemoryCoreMergeHygienePaths(paths: Iterable<string>): string[] {
  return [...new Set(Array.from(paths, normalizeRepoPath).filter(isMemoryCoreMergeHygienePath))].sort();
}

export function collectSourceInventory(sourceText: string, filePath = 'input.ts'): SourceInventory {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return {
    declarationSymbols: collectDeclarationSymbols(sourceFile),
    diagnostics: collectSourceDiagnostics(sourceFile),
    exportedDeclarationSymbols: collectExportedDeclarationSymbols(sourceFile),
    importSpecifiers: collectImportSpecifiers(sourceFile),
    testNames: collectTestNames(sourceFile),
  };
}

export function diffInventories(
  parentInventory: SourceInventory,
  mergeInventory: SourceInventory,
): Pick<
  ParentMergeHygieneResult,
  | 'diagnostics'
  | 'missingDeclarationSymbols'
  | 'missingExportedDeclarationSymbols'
  | 'missingImportSpecifiers'
  | 'missingTestNames'
> {
  return {
    diagnostics: mergeInventory.diagnostics,
    missingDeclarationSymbols: subtractItems(parentInventory.declarationSymbols, mergeInventory.declarationSymbols),
    missingExportedDeclarationSymbols: subtractItems(
      parentInventory.exportedDeclarationSymbols,
      mergeInventory.exportedDeclarationSymbols,
    ),
    missingImportSpecifiers: subtractItems(parentInventory.importSpecifiers, mergeInventory.importSpecifiers),
    missingTestNames: subtractItems(parentInventory.testNames, mergeInventory.testNames),
  };
}

export function runMemoryCoreMergeHygiene(options: RunMergeHygieneOptions = {}): MemoryCoreMergeHygieneReport {
  const mergeRef = options.mergeRef ?? 'HEAD';
  const git = options.git ?? createGitReader(options.cwd ?? process.cwd());
  const parentRefs = git.resolveParentRefs(mergeRef);
  if (parentRefs.length < 2) {
    return {
      checked: false,
      mergeRef,
      ok: true,
      parentResults: [],
      skippedReason: `${mergeRef} is not a merge commit; Memory Core merge hygiene runs only on merge commits.`,
    };
  }

  const parentResults = parentRefs.map((parentRef) => {
    const changedPaths = selectMemoryCoreMergeHygienePaths(git.listChangedFiles(parentRef, mergeRef));
    const parentInventory = aggregateInventory(parentRef, changedPaths, git);
    const mergeInventory = aggregateInventory(mergeRef, changedPaths, git);
    const missing = diffInventories(parentInventory, mergeInventory);
    return {
      changedPaths,
      diagnostics: missing.diagnostics,
      missingDeclarationSymbols: missing.missingDeclarationSymbols,
      missingExportedDeclarationSymbols: missing.missingExportedDeclarationSymbols,
      missingImportSpecifiers: missing.missingImportSpecifiers,
      missingTestNames: missing.missingTestNames,
      parentRef,
    } satisfies ParentMergeHygieneResult;
  });

  const checked = parentResults.some((result) => result.changedPaths.length > 0);
  const ok = parentResults.every(
    (result) =>
      result.diagnostics.length === 0 &&
      result.missingDeclarationSymbols.length === 0 &&
      result.missingExportedDeclarationSymbols.length === 0 &&
      result.missingImportSpecifiers.length === 0 &&
      result.missingTestNames.length === 0,
  );
  return {
    checked,
    mergeRef,
    ok,
    parentResults,
    ...(checked
      ? {}
      : { skippedReason: 'No Memory Core / AutoResearchClaw TypeScript paths changed across merge parents.' }),
  };
}

export function formatMemoryCoreMergeHygieneReport(report: MemoryCoreMergeHygieneReport): string {
  if (!report.checked) {
    return `Memory Core merge hygiene skipped: ${report.skippedReason ?? 'no merge parents'}`;
  }
  if (report.ok) {
    const touchedCount = report.parentResults.reduce((count, result) => count + result.changedPaths.length, 0);
    return `Memory Core merge hygiene passed for ${report.mergeRef} across ${report.parentResults.length} parents (${touchedCount} targeted path checks).`;
  }

  const lines = [`Memory Core merge hygiene failed for ${report.mergeRef}:`];
  for (const result of report.parentResults) {
    if (
      result.diagnostics.length === 0 &&
      result.missingTestNames.length === 0 &&
      result.missingDeclarationSymbols.length === 0 &&
      result.missingExportedDeclarationSymbols.length === 0 &&
      result.missingImportSpecifiers.length === 0
    ) {
      continue;
    }
    lines.push(`- Parent ${result.parentRef}`);
    if (result.changedPaths.length > 0) lines.push(`  changed: ${result.changedPaths.join(', ')}`);
    if (result.diagnostics.length > 0) lines.push(`  diagnostics: ${result.diagnostics.join(', ')}`);
    if (result.missingTestNames.length > 0) lines.push(`  missing tests: ${result.missingTestNames.join(', ')}`);
    if (result.missingDeclarationSymbols.length > 0) {
      lines.push(`  missing declarations: ${result.missingDeclarationSymbols.join(', ')}`);
    }
    if (result.missingExportedDeclarationSymbols.length > 0) {
      lines.push(`  missing exported declarations: ${result.missingExportedDeclarationSymbols.join(', ')}`);
    }
    if (result.missingImportSpecifiers.length > 0) {
      lines.push(`  missing import specifiers: ${result.missingImportSpecifiers.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function runMemoryCoreMergeHygieneCli(args: string[]): number {
  let mergeRef = 'HEAD';
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--merge') {
      const next = args[index + 1];
      if (!next) throw new Error('--merge requires a ref');
      mergeRef = next;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const report = runMemoryCoreMergeHygiene({ mergeRef });
  const rendered = json ? `${JSON.stringify(report, null, 2)}\n` : `${formatMemoryCoreMergeHygieneReport(report)}\n`;
  if (json) {
    process.stdout.write(rendered);
    return report.ok ? 0 : 1;
  }
  if (report.ok) {
    process.stdout.write(rendered);
    return 0;
  }
  process.stderr.write(rendered);
  return 1;
}

function createGitReader(cwd: string): MergeHygieneGitReader {
  return {
    listChangedFiles(parentRef, mergeRef) {
      const output = execGit(['diff', '--name-only', parentRef, mergeRef, '--', 'tests', 'src', 'packages'], cwd);
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },
    readFileAtRef(ref, filePath) {
      try {
        return execGit(['show', `${ref}:${filePath}`], cwd);
      } catch {
        return undefined;
      }
    },
    resolveParentRefs(ref) {
      const output = execGit(['rev-list', '--parents', '-n', '1', ref], cwd).trim();
      const [, ...parents] = output.split(/\s+/).filter(Boolean);
      return parents;
    },
  };
}

function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(formatGitFailure(args, error), { cause: error });
  }
}

function formatGitFailure(args: string[], error: unknown): string {
  const stderr = gitFailureStderr(error).trim();
  const command = `git ${args.join(' ')}`;
  return stderr ? `${command} failed: ${stderr}` : `${command} failed`;
}

function gitFailureStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  return typeof stderr === 'string' ? stderr : '';
}

function aggregateInventory(ref: string, filePaths: string[], git: MergeHygieneGitReader): SourceInventory {
  const declarationSymbols = new Set<string>();
  const diagnostics = new Set<string>();
  const exportedDeclarationSymbols = new Set<string>();
  const importSpecifiers = new Set<string>();
  const testNames = new Set<string>();

  for (const filePath of filePaths) {
    const contents = git.readFileAtRef(ref, filePath);
    if (contents === undefined) continue;
    const inventory = collectSourceInventory(contents, filePath);
    for (const symbol of inventory.declarationSymbols) declarationSymbols.add(symbol);
    for (const diagnostic of inventory.diagnostics) diagnostics.add(`${filePath}:${diagnostic}`);
    for (const symbol of inventory.exportedDeclarationSymbols) exportedDeclarationSymbols.add(symbol);
    for (const specifier of inventory.importSpecifiers) importSpecifiers.add(specifier);
    for (const testName of inventory.testNames) testNames.add(testName);
  }

  return {
    declarationSymbols: [...declarationSymbols].sort(),
    diagnostics: [...diagnostics].sort(),
    exportedDeclarationSymbols: [...exportedDeclarationSymbols].sort(),
    importSpecifiers: [...importSpecifiers].sort(),
    testNames: [...testNames].sort(),
  };
}

function collectDeclarationSymbols(sourceFile: ts.SourceFile): string[] {
  const symbols = new Set<string>();
  for (const statement of sourceFile.statements) {
    collectStatementSymbols(statement, symbols);
  }
  return [...symbols].sort();
}

function collectStatementSymbols(statement: ts.Statement, symbols: Set<string>): void {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    symbols.add(`function:${statement.name.text}`);
    return;
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    symbols.add(`class:${statement.name.text}`);
    return;
  }
  if (ts.isInterfaceDeclaration(statement)) {
    symbols.add(`interface:${statement.name.text}`);
    return;
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    symbols.add(`type:${statement.name.text}`);
    return;
  }
  if (ts.isEnumDeclaration(statement)) {
    symbols.add(`enum:${statement.name.text}`);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    const kind = variableDeclarationKind(statement.declarationList);
    for (const name of collectBindingNames(statement.declarationList.declarations)) {
      symbols.add(`${kind}:${name}`);
    }
    return;
  }
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) {
      symbols.add(`export:${element.name.text}`);
    }
  }
}

function collectExportedDeclarationSymbols(sourceFile: ts.SourceFile): string[] {
  const symbols = new Set<string>();
  for (const statement of sourceFile.statements) {
    collectStatementSymbols(statement, exportedSymbolsForStatement(statement, symbols));
  }
  return [...symbols].sort();
}

function exportedSymbolsForStatement(statement: ts.Statement, symbols: Set<string>): Set<string> {
  if (hasExportModifier(statement)) return symbols;
  if (ts.isExportDeclaration(statement)) return symbols;
  return new Set<string>();
}

function variableDeclarationKind(declarationList: ts.VariableDeclarationList): 'const' | 'let' | 'var' {
  if (declarationList.flags & ts.NodeFlags.Const) return 'const';
  if (declarationList.flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function collectBindingNames(declarations: ts.NodeArray<ts.VariableDeclaration>): string[] {
  const names: string[] = [];
  for (const declaration of declarations) {
    appendBindingName(declaration.name, names);
  }
  return names;
}

function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = stringLiteralText(statement.moduleSpecifier);
    if (!moduleSpecifier) continue;
    specifiers.add(moduleSpecifier);
  }
  return [...specifiers].sort();
}

function collectSourceDiagnostics(sourceFile: ts.SourceFile): string[] {
  const diagnostics: string[] = [];
  if (hasConflictMarkersOutsideTriviaAndLiterals(sourceFile.text)) diagnostics.push('unresolved-conflict-marker');
  diagnostics.push(...collectForbiddenSemanticLexemeDiagnostics(sourceFile));
  return diagnostics.sort();
}

function collectForbiddenSemanticLexemeDiagnostics(sourceFile: ts.SourceFile): string[] {
  const matchedIds = new Set<string>();

  const visit = (node: ts.Node): void => {
    const semanticText = semanticForbiddenLexemeText(node);
    if (semanticText) {
      for (const item of MEMORY_CORE_FORBIDDEN_LEXICAL_PATTERNS) {
        if (item.pattern.test(semanticText)) matchedIds.add(item.id);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...matchedIds].sort().map((id) => `forbidden-lexeme:${id}`);
}

function semanticForbiddenLexemeText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (
    (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    isStaticSemanticPropertyName(node)
  ) {
    return node.text;
  }
  return undefined;
}

function isStaticSemanticPropertyName(
  node: ts.StringLiteral | ts.NumericLiteral | ts.NoSubstitutionTemplateLiteral,
): boolean {
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return (
    ts.isComputedPropertyName(parent) &&
    parent.expression === node &&
    parent.parent !== undefined &&
    (ts.isPropertyAssignment(parent.parent) ||
      ts.isPropertyDeclaration(parent.parent) ||
      ts.isPropertySignature(parent.parent) ||
      ts.isMethodDeclaration(parent.parent) ||
      ts.isMethodSignature(parent.parent) ||
      ts.isGetAccessorDeclaration(parent.parent) ||
      ts.isSetAccessorDeclaration(parent.parent))
  );
}

function hasConflictMarkersOutsideTriviaAndLiterals(sourceText: string): boolean {
  return /^\s*(?:<{7}|={7}|>{7})(?:\s|$)/m.test(maskTriviaAndLiteralText(sourceText));
}

function maskTriviaAndLiteralText(sourceText: string): string {
  const chars = sourceText.split('');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
    undefined,
    0,
    sourceText.length,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (shouldMaskToken(token)) {
      maskRange(chars, scanner.getTokenStart(), scanner.getTextPos());
    }
    token = scanner.scan();
  }
  return chars.join('');
}

function shouldMaskToken(token: ts.SyntaxKind): boolean {
  return (
    token === ts.SyntaxKind.SingleLineCommentTrivia ||
    token === ts.SyntaxKind.MultiLineCommentTrivia ||
    token === ts.SyntaxKind.StringLiteral ||
    token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    token === ts.SyntaxKind.TemplateHead ||
    token === ts.SyntaxKind.TemplateMiddle ||
    token === ts.SyntaxKind.TemplateTail
  );
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function appendBindingName(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isBindingElement(element)) continue;
    appendBindingName(element.name, names);
  }
}

function collectTestNames(sourceFile: ts.SourceFile): string[] {
  const testNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const rootName = callRootName(node.expression);
      if ((rootName === 'it' || rootName === 'test') && node.arguments.length > 0) {
        const testName = stringLiteralText(node.arguments[0]!);
        if (testName) testNames.add(testName);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...testNames].sort();
}

function callRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return callRootName(expression.expression);
  if (ts.isCallExpression(expression)) return callRootName(expression.expression);
  return undefined;
}

function stringLiteralText(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return undefined;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function subtractItems(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}
