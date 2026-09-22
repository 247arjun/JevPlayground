import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { implementation } from './syntax.js'

let program: ts.Program | undefined
let root = ''
let diagnostics: string[] = []
const libraryRoot = path.dirname(ts.getDefaultLibFilePath({}))
function allowed (file: string): boolean {
  const absolute = path.resolve(file)
  if (!(absolute.startsWith(root + path.sep) || absolute.startsWith(libraryRoot + path.sep))) return false
  try { return realpathSync(absolute) === absolute && !lstatSync(absolute).isSymbolicLink() } catch { return false }
}
function safeRead (file: string): string | undefined {
  if (!allowed(file)) return undefined
  const bytes = readFileSync(file)
  if (bytes.length > 16 * 1024 * 1024) throw new Error('resource_limited')
  return bytes.toString()
}

function callTargets (call: ts.CallExpression | ts.NewExpression): Array<Record<string, unknown>> {
  const checker = program!.getTypeChecker()
  const signature = checker.getResolvedSignature(call)
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const declarations = [...(signature?.declaration ? [signature.declaration] : []), ...(symbol?.getDeclarations() ?? [])]
  const targets = new Map<string, Record<string, unknown>>()
  for (let declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && implementation(declaration.initializer)) declaration = declaration.initializer
    const source = declaration.getSourceFile()
    const relative = path.relative(root, source.fileName).split(path.sep).join('/')
    if (relative.startsWith('../')) continue
    const start = declaration.getStart(source); const end = declaration.getEnd()
    targets.set(`${relative}:${start}-${end}`, { id: `${relative}:${start}-${end}`, file: relative, start, end, implementation: implementation(declaration), basis: 'compiler_resolved_candidate' })
  }
  return [...targets.values()].slice(0, 100)
}

function * callNodes (node: ts.Node): Generator<ts.CallExpression | ts.NewExpression> {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) yield node
  const children: ts.Node[] = []
  ts.forEachChild(node, child => { children.push(child) })
  for (const child of children) yield * callNodes(child)
}

type CallCursor = { file: string, ordinal: number }
function callers (targetId: string, cursor: CallCursor | undefined, limit: number): Record<string, unknown> {
  const files = program!.getSourceFiles().filter(file => !file.isDeclarationFile && file.fileName.startsWith(root + path.sep))
    .sort((first, second) => first.fileName.localeCompare(second.fileName))
  const rows: Array<Record<string, unknown>> = []
  let examined = 0; let unresolved = 0; let filesExamined = 0
  let last: CallCursor | null = cursor ?? null
  for (const source of files) {
    const relative = path.relative(root, source.fileName).split(path.sep).join('/')
    if (cursor && relative.localeCompare(cursor.file) < 0) continue
    if (filesExamined++ >= 10) return { rows, cursor: last, examined, unresolved, exhausted: false }
    let ordinal = 0
    for (const call of callNodes(source)) {
      const position = ordinal++
      if (cursor?.file === relative && position <= cursor.ordinal) continue
      if (examined >= 500 || rows.length >= limit) return { rows, cursor: last, examined, unresolved, exhausted: false }
      const targets = callTargets(call)
      examined++; last = { file: relative, ordinal: position }
      if (!targets.length) unresolved++
      if (!targets.some(target => target.id === targetId)) continue
      let owner: ts.Node | undefined = call.parent
      while (owner && !implementation(owner)) owner = owner.parent
      const start = call.getStart(source); const end = call.getEnd()
      rows.push({ id: `${relative}:${start}-${end}`, file: relative, start, end,
        callerId: owner ? `${relative}:${owner.getStart(source)}-${owner.getEnd()}` : null,
        targetId, basis: 'compiler_resolved_candidate', arguments: (call.arguments ?? []).slice(0, 100).map(argument => ({ start: argument.getStart(source), end: argument.getEnd() })) })
    }
    last = { file: relative, ordinal: Math.max(-1, ordinal - 1) }
  }
  return { rows, cursor: null, examined, unresolved, exhausted: true }
}

process.on('message', (message: { id: number, method: string, root: string, project?: string, file?: string, start?: number, targetId?: string, cursor?: CallCursor, limit?: number }) => {
  try {
    if (message.method === 'load') {
      root = realpathSync(message.root)
      const configFile = path.resolve(root, message.project!)
      if (!allowed(configFile)) throw new Error('configuration_outside_snapshot')
      const host: ts.ParseConfigFileHost = {
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => root,
        readDirectory: (directory, extensions, excludes, includes, depth) => (path.resolve(directory) === root || path.resolve(directory).startsWith(root + path.sep)) ? ts.sys.readDirectory(directory, extensions, excludes, includes, depth).filter(allowed) : [],
        fileExists: allowed,
        readFile: safeRead,
        onUnRecoverableConfigFileDiagnostic: () => { diagnostics.push('configuration_error') }
      }
      const parsed = ts.getParsedCommandLineOfConfigFile(configFile, { noEmit: true, allowJs: true }, host)
      if (!parsed || parsed.fileNames.length > 20000) throw new Error('resource_limited')
      diagnostics = parsed.errors.length ? ['configuration_error'] : []
      const compilerHost = ts.createCompilerHost(parsed.options)
      compilerHost.readFile = safeRead
      compilerHost.fileExists = allowed
      compilerHost.getSourceFile = (file, version) => {
        const source = safeRead(file)
        return source === undefined ? undefined : ts.createSourceFile(file, source, version, true)
      }
      program = ts.createProgram({ rootNames: parsed.fileNames.filter(allowed), options: parsed.options, projectReferences: parsed.projectReferences, host: compilerHost })
      // Do not request whole-program semantic diagnostics just for navigation.
      if (program.getOptionsDiagnostics().length) diagnostics.push('compiler_options_diagnostic')
      process.send?.({ id: message.id, value: { loadedFiles: program.getSourceFiles().length, diagnostics, memoryRss: process.memoryUsage().rss, compilerVersion: ts.version } })
      return
    }
    if (message.method === 'callers') {
      if (!program || !message.targetId || !Number.isInteger(message.limit) || message.limit! < 1 || message.limit! > 50) throw new Error('invalid_caller_request')
      const result = callers(message.targetId, message.cursor, message.limit!)
      process.send?.({ id: message.id, value: { ...result, capability: 'semantic_partial', completion: 'partial',
        reasons: [...diagnostics, 'unsearched_projects_and_external_consumers', 'dynamic_dispatch_not_exhaustive'], memoryRss: process.memoryUsage().rss } })
      return
    }
    if (!program || !message.file || message.start === undefined) throw new Error('workspace_not_loaded')
    const file = program.getSourceFile(path.resolve(root, message.file))
    if (!file) throw new Error('file_not_in_project')
    let selected: ts.CallExpression | ts.NewExpression | undefined
    const visit = (node: ts.Node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.getStart(file) === message.start) selected = node
      if (node.pos <= message.start! && node.end >= message.start!) ts.forEachChild(node, visit)
    }
    visit(file)
    if (!selected) throw new Error('call_site_not_found')
    const call: ts.CallExpression | ts.NewExpression = selected
    const targets = callTargets(call)
    process.send?.({ id: message.id, value: { targets, capability: 'semantic_partial', completion: 'partial', reasons: [...diagnostics, 'dynamic_dispatch_not_exhaustive', ...(!targets.length ? ['unresolved_target_or_missing_dependency'] : [])], memoryRss: process.memoryUsage().rss } })
  } catch (error) {
    const messageText = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'semantic_resolution_failed'
    process.send?.({ id: message.id, error: messageText })
  }
})