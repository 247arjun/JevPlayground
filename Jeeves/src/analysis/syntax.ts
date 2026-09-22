import ts from 'typescript'

export type Site = { id: string, file: string, start: number, end: number, callerId: string | null, name: string, expression: string, data: Record<string, unknown> }
export type Registration = { id: string, file: string, start: number, kind: string, data: Record<string, unknown> }
export function implementation (node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && Boolean(node.body)
}

export function maskComments (file: string, source: string): string {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, parsed.languageVariant)
  const ranges: Array<{ start: number, end: number }> = []
  let cursor = 0
  const gap = (start: number, end: number) => {
    if (end <= start) return
    scanner.setText(source, start, end - start)
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) ranges.push({ start: scanner.getTokenPos(), end: scanner.getTextPos() })
    }
  }
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      gap(cursor, ts.isJsxText(node) ? node.getFullStart() : node.getStart(parsed)); cursor = node.getEnd(); return
    }
    for (const child of node.getChildren(parsed)) visit(child)
  }
  visit(parsed); gap(cursor, source.length)
  const pieces: string[] = []; cursor = 0
  for (const range of ranges) {
    pieces.push(source.slice(cursor, range.start), source.slice(range.start, range.end).replace(/[^\r\n\u2028\u2029]/g, ' ')); cursor = range.end
  }
  pieces.push(source.slice(cursor))
  return pieces.join('')
}

export function syntaxIndex (file: string, source: string): { calls: Site[], registrations: Registration[], diagnostics: string[] } {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const calls: Site[] = []
  const registrations: Registration[] = []
  const imports = new Map<string, string>()
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text
      if (statement.importClause?.name) imports.set(statement.importClause.name.text, module)
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, module)
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imports.set(element.name.text, module)
    }
  }
  function visit (node: ts.Node, parentId: string | null) {
    if (implementation(node)) parentId = `${file}:${node.getStart(parsed)}-${node.getEnd()}`
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '<computed>'
      const start = node.getStart(parsed)
      const id = `${file}:${start}-${node.getEnd()}`
      let base: ts.Expression = expression
      while (ts.isPropertyAccessExpression(base)) base = base.expression
      const module = ts.isIdentifier(base) ? imports.get(base.text) : undefined
      const callbacks = (node.arguments ?? []).filter(implementation).map(callback => ({ start: callback.getStart(parsed), end: callback.getEnd() }))
      const data = { arguments: (node.arguments ?? []).map(argument => ({ start: argument.getStart(parsed), end: argument.getEnd() })), module: module ?? null, callbacks, kind: ts.isNewExpression(node) ? 'constructor' : 'call', resolution: 'unresolved' }
      calls.push({ id, file, start, end: node.getEnd(), callerId: parentId, name, expression: expression.getText(parsed).slice(0, 1024), data })
      if (callbacks.length || module === '@azure/functions' || ['get', 'post', 'use', 'MapGet', 'MapPost', 'on'].includes(name)) {
        registrations.push({ id, file, start, kind: module === '@azure/functions' ? 'azure_functions_registration_candidate' : 'callback_or_route_candidate', data: { ...data, name, basis: module ? 'import_and_syntax' : 'syntax_only', limitation: 'Registration is not invocation; middleware ordering and receiver identity require semantic inspection.' } })
      }
    }
    ts.forEachChild(node, child => visit(child, parentId))
  }
  visit(parsed, null)
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  return { calls, registrations, diagnostics }
}

export function localEvidence (file: string, source: string, start: number, end: number): Record<string, unknown> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const definitions: Array<Record<string, unknown>> = []
  const guards: Array<Record<string, unknown>> = []
  const operations: Array<Record<string, unknown>> = []
  function visit (node: ts.Node) {
    if (node.getEnd() < start || node.getStart(parsed) > end) return
    const range = { start: node.getStart(parsed), end: node.getEnd(), kind: ts.SyntaxKind[node.kind] }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isReturnStatement(node)) definitions.push(range)
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isTryStatement(node)) guards.push(range)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) operations.push(range)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return { definitions: definitions.slice(0, 100), guards: guards.slice(0, 100), operations: operations.slice(0, 100), capability: 'syntax_only', completion: 'partial', reasons: ['candidates_not_reaching_definition_proof', ...(definitions.length > 100 || guards.length > 100 || operations.length > 100 ? ['page_budget'] : [])] }
}