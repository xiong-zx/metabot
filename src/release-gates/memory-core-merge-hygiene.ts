import { execFileSync } from 'node:child_process';
import process from 'node:process';
import ts from 'typescript';

export const MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERN =
  /^(?:src|tests|packages)\/.*(?:memory-core|research-memory|autoresearchclaw|worker-manager).*\.ts$/;

export interface SourceInventory {
  declarationSymbols: string[];
  testNames: string[];
}

export interface ParentMergeHygieneResult {
  changedPaths: string[];
  missingDeclarationSymbols: string[];
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
  return MEMORY_CORE_MERGE_HYGIENE_PATH_PATTERN.test(normalizeRepoPath(filePath));
}

export function selectMemoryCoreMergeHygienePaths(paths: Iterable<string>): string[] {
  return [...new Set(Array.from(paths, normalizeRepoPath).filter(isMemoryCoreMergeHygienePath))].sort();
}

export function collectSourceInventory(sourceText: string, filePath = 'input.ts'): SourceInventory {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return {
    declarationSymbols: collectDeclarationSymbols(sourceFile),
    testNames: collectTestNames(sourceFile),
  };
}

export function diffInventories(
  parentInventory: SourceInventory,
  mergeInventory: SourceInventory,
): Pick<ParentMergeHygieneResult, 'missingDeclarationSymbols' | 'missingTestNames'> {
  return {
    missingDeclarationSymbols: subtractItems(
      parentInventory.declarationSymbols,
      mergeInventory.declarationSymbols,
    ),
    missingTestNames: subtractItems(parentInventory.testNames, mergeInventory.testNames),
  };
}

export function runMemoryCoreMergeHygiene(
  options: RunMergeHygieneOptions = {},
): MemoryCoreMergeHygieneReport {
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
      missingDeclarationSymbols: missing.missingDeclarationSymbols,
      missingTestNames: missing.missingTestNames,
      parentRef,
    } satisfies ParentMergeHygieneResult;
  });

  const checked = parentResults.some((result) => result.changedPaths.length > 0);
  const ok = parentResults.every(
    (result) => result.missingDeclarationSymbols.length === 0 && result.missingTestNames.length === 0,
  );
  return {
    checked,
    mergeRef,
    ok,
    parentResults,
    ...(checked ? {} : { skippedReason: 'No Memory Core / AutoResearchClaw TypeScript paths changed across merge parents.' }),
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
    if (result.missingTestNames.length === 0 && result.missingDeclarationSymbols.length === 0) continue;
    lines.push(`- Parent ${result.parentRef}`);
    if (result.changedPaths.length > 0) lines.push(`  changed: ${result.changedPaths.join(', ')}`);
    if (result.missingTestNames.length > 0) lines.push(`  missing tests: ${result.missingTestNames.join(', ')}`);
    if (result.missingDeclarationSymbols.length > 0) {
      lines.push(`  missing declarations: ${result.missingDeclarationSymbols.join(', ')}`);
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
      return output.split('\n').map((line) => line.trim()).filter(Boolean);
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
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function aggregateInventory(ref: string, filePaths: string[], git: MergeHygieneGitReader): SourceInventory {
  const declarationSymbols = new Set<string>();
  const testNames = new Set<string>();

  for (const filePath of filePaths) {
    const contents = git.readFileAtRef(ref, filePath);
    if (contents === undefined) continue;
    const inventory = collectSourceInventory(contents, filePath);
    for (const symbol of inventory.declarationSymbols) declarationSymbols.add(symbol);
    for (const testName of inventory.testNames) testNames.add(testName);
  }

  return {
    declarationSymbols: [...declarationSymbols].sort(),
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
