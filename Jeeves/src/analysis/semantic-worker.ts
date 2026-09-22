import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
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

process.on('message', (message: { id: number, method: string, root: string, project?: string, file?: string, start?: number }) => {
  try {
    if (message.method === 'load') {
      root = realpathSync(message.root)
      const configFile = path.resolve(root, message.project!)
      if (!allowed(configFile)) throw new Error('configuration_outside_snapshot')
      const host: ts.ParseConfigFileHost = {
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => root,
        readDirectory: (directory, extensions, excludes, includes, depth) => path.resolve(directory).startsWith(root) ? ts.sys.readDirectory(directory, extensions, excludes, includes, depth).filter(allowed) : [],
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
    const checker = program.getTypeChecker()
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
    process.send?.({ id: message.id, value: { targets: [...targets.values()].slice(0, 100), capability: 'semantic_partial', completion: 'partial', reasons: [...diagnostics, 'dynamic_dispatch_not_exhaustive', ...(!targets.size ? ['unresolved_target_or_missing_dependency'] : [])], memoryRss: process.memoryUsage().rss } })
  } catch (error) {
    const messageText = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'semantic_resolution_failed'
    process.send?.({ id: message.id, error: messageText })
  }
})