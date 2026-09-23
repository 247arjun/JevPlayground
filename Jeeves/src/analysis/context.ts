import path from 'node:path'
import ts from 'typescript'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { Parser, parseDocument, visit as visitYaml, isMap, isSeq } from 'yaml'
import { defaultLimits } from '../domain.js'
import { hash, readBounded, relativePath } from '../security.js'
import { putArtifact, type Store } from '../storage/store.js'
import { implementation, maskComments } from './syntax.js'
import { pathPurpose } from './purpose.js'
import type { SyntaxWorker } from './syntax-client.js'
import type { CSharp } from './csharp.js'

type Anchor = { start: number, end: number, kind: string, data: Record<string, unknown> }
type Relationship = Anchor & { target: string }
export type ContextEvidence = { sanitized: string, anchors: Anchor[], subjects: Anchor[], relationships: Relationship[], reasons: string[] }

export function contextEvidence (file: string, source: string, language: string): ContextEvidence {
  const result: ContextEvidence = { sanitized: source, anchors: [], subjects: [], relationships: [], reasons: [] }
  const comments: Array<{ start: number, end: number }> = []
  const count = () => { if (result.anchors.length + result.relationships.length > 50000) throw new Error('context_node_limit') }
  if (language === 'tsjs') {
    result.sanitized = maskComments(file, source)
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    if ((parsed as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) result.reasons.push('typescript_parse_error')
    const imports = new Map<string, string>()
    const location = (node: ts.Node, kind: string, data: Record<string, unknown> = {}): Anchor => ({ start: node.getStart(parsed), end: node.getEnd(), kind, data })
    for (const statement of parsed.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const module = statement.moduleSpecifier.text
        if (statement.importClause?.name) imports.set(statement.importClause.name.text, module)
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, module)
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) imports.set(binding.name.text, module)
        result.relationships.push({ ...location(statement, 'import', { basis: 'module_specifier', runtimeUseNotProven: true }), target: module })
      } else if (!ts.isFunctionDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement)) {
        const anchor = location(statement, 'declaration', { syntaxKind: ts.SyntaxKind[statement.kind] })
        result.anchors.push(anchor); result.subjects.push(anchor)
      }
    }
    const walk = (node: ts.Node) => {
      count()
      if (implementation(node)) {
        const anchor = location(node, 'unclassified_function', { syntaxKind: ts.SyntaxKind[node.kind] })
        result.anchors.push(anchor); result.subjects.push(anchor)
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(parsed).replaceAll(/["']/g, '') === 'templateUrl' && ts.isStringLiteralLike(node.initializer)) {
        result.relationships.push({ ...location(node, 'component_template', { basis: 'declared_template_url' }), target: node.initializer.text })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text
        const receiver = node.expression.expression.getText(parsed)
        const first = node.arguments[0]
        if (['get', 'post', 'put', 'patch', 'delete', 'use', 'route', 'all'].includes(name) && first && ts.isStringLiteralLike(first) && first.text.startsWith('/')) {
          const handlers = node.arguments.slice(1).map(argument => argument.getText(parsed).slice(0, 256))
          const anchor = location(node, 'route_declaration', { method: name, path: first.text, receiver, handlers, middlewareOrder: node.getStart(parsed), basis: 'syntax_candidate_not_runtime_proof' })
          result.anchors.push(anchor); result.subjects.push(anchor)
          const linkArgument = (argument: ts.Node) => {
            if (implementation(argument)) return
            if (ts.isIdentifier(argument) && imports.has(argument.text)) result.relationships.push({ ...anchor, kind: 'route_handler', target: imports.get(argument.text)!, data: { ...anchor.data, symbol: argument.text } })
            ts.forEachChild(argument, linkArgument)
          }
          for (const argument of node.arguments.slice(1)) linkArgument(argument)
        }
        if (name === 'resource' && (imports.get(receiver) === 'finale-rest' || imports.get(receiver) === 'finale')) {
          const anchor = location(node, 'generated_crud', { receiver, basis: 'import_and_registration', limitation: 'Review surrounding model declarations, HTTP-method middleware and framework implementation; registration alone is not authorization.' })
          result.anchors.push(anchor); result.subjects.push(anchor)
        }
        if (['create', 'insert', 'save', 'update', 'findOne', 'findAll', 'findByPk', 'query'].includes(name)) result.relationships.push({ ...location(node, 'persistence_boundary', { receiver, operation: name, basis: 'syntax_only', relation: 'Shared receiver names do not prove dataflow.' }), target: receiver })
      }
      ts.forEachChild(node, walk)
    }
    walk(parsed)
  } else if (language === 'template' && /\.(?:html?|vue|svelte)$/i.test(file)) {
    const document = parse(source, { sourceCodeLocationInfo: true })
    const walk = (node: DefaultTreeAdapterMap['node']) => {
      count()
      const location = node.sourceCodeLocation
      if (node.nodeName === '#comment' && location) comments.push({ start: location.startOffset, end: location.endOffset })
      else if (location) {
        const anchor = { start: location.startOffset, end: location.endOffset, kind: 'template_node', data: { node: node.nodeName, basis: 'html_syntax' } }
        result.anchors.push(anchor)
        if ('attrs' in node) for (const attribute of node.attrs) {
          const range = 'attrs' in location ? location.attrs?.[attribute.name] : undefined
          if (range) result.anchors.push({ start: range.startOffset, end: range.endOffset, kind: 'template_attribute', data: { name: attribute.name, htmlBinding: ['[innerhtml]', 'v-html'].includes(attribute.name), basis: 'declared_binding_not_exploitability' } })
        }
      }
      if ('childNodes' in node) for (const child of node.childNodes) walk(child)
      if ('content' in node) walk(node.content)
    }
    walk(document)
    if (source.length) result.subjects.push({ start: 0, end: source.length, kind: 'template', data: { parser: 'parse5', caveat: 'Framework-specific expression semantics require component evidence.' } })
  } else if (/\.(?:jsonc?)$/i.test(file)) {
    const parsed = ts.parseJsonText(file, source)
    if ((parsed as ts.JsonSourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length) result.reasons.push('json_parse_error')
    result.sanitized = maskComments(file, source)
    const walk = (node: ts.Node) => {
      count()
      if (ts.isPropertyAssignment(node)) result.anchors.push({ start: node.getStart(parsed), end: node.getEnd(), kind: 'configuration_property', data: { key: node.name.getText(parsed).slice(0, 256) } })
      ts.forEachChild(node, walk)
    }
    walk(parsed)
    if (source.length) result.subjects.push({ start: 0, end: source.length, kind: path.basename(file) === 'package.json' || /lock/.test(path.basename(file)) ? 'dependency_manifest' : 'configuration', data: { parser: 'typescript_json', advisoryAssessment: 'not_performed' } })
  } else if (/\.ya?ml$/i.test(file)) {
    const document = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true })
    if (document.errors.length) result.reasons.push('yaml_parse_error')
    visitYaml(document, (_key, node) => {
      count()
      if (node && typeof node === 'object' && 'range' in node && Array.isArray(node.range)) result.anchors.push({ start: node.range[0], end: node.range[1], kind: 'configuration_node', data: { container: isMap(node) ? 'map' : isSeq(node) ? 'sequence' : 'scalar' } })
    })
    const stack: unknown[] = [...new Parser().parse(source)]
    while (stack.length) {
      const token = stack.pop()
      if (!token || typeof token !== 'object') continue
      if ('type' in token && token.type === 'comment' && 'offset' in token && 'source' in token && typeof token.offset === 'number' && typeof token.source === 'string') comments.push({ start: token.offset, end: token.offset + token.source.length })
      for (const child of Object.values(token)) if (child && typeof child === 'object') stack.push(...(Array.isArray(child) ? child : [child]))
    }
    if (source.length) result.subjects.push({ start: 0, end: source.length, kind: 'configuration', data: { parser: 'yaml', aliasesExpanded: false } })
  } else if (language !== 'csharp' && source.length) {
    result.subjects.push({ start: 0, end: source.length, kind: language === 'template' ? 'template' : 'configuration', data: { capability: 'text_only' } })
    result.reasons.push('format_semantics_unavailable')
  }
  if (comments.length) {
    let cursor = 0; const pieces: string[] = []
    for (const range of comments.sort((left, right) => left.start - right.start)) {
      if (range.start < cursor) continue
      pieces.push(source.slice(cursor, range.start), source.slice(range.start, range.end).replace(/[^\r\n\u2028\u2029]/g, ' ')); cursor = range.end
    }
    pieces.push(source.slice(cursor)); result.sanitized = pieces.join('')
  }
  return result
}

export async function buildContextIndex (store: Store, parser: SyntaxWorker, csharp: CSharp): Promise<void> {
  const root = path.join(store.root, 'snapshot/source')
  for await (const file of store.scan('files')) {
    const relative = String(file.path)
    if ((await store.query('SELECT hash FROM context_files WHERE file=?', [relative]))[0]?.hash === file.hash) continue
    const source = (await readBounded(root, relative, defaultLimits.maxFileBytes)).toString()
    if (hash(source) !== file.hash) throw new Error('snapshot_hash_mismatch')
    await store.batch([{ sql: 'DELETE FROM source_anchors WHERE file=?', params: [relative] }, { sql: 'DELETE FROM relationships WHERE file=?', params: [relative] }, { sql: 'DELETE FROM source_search WHERE file=?', params: [relative] }, { sql: 'DELETE FROM context_text WHERE file=?', params: [relative] }])
    let evidence: ContextEvidence
    try {
      if (file.language === 'csharp') {
        const comments = await csharp.request('comments', { file: relative }) as { ranges: Array<{ start: number, end: number }> }
        let cursor = 0; const pieces: string[] = []
        for (const range of comments.ranges) { pieces.push(source.slice(cursor, range.start), source.slice(range.start, range.end).replace(/[^\r\n\u2028\u2029]/g, ' ')); cursor = range.end }
        pieces.push(source.slice(cursor))
        const classified = (await store.query('SELECT id FROM functions WHERE file=? LIMIT 1', [relative])).length > 0
        const subjects = !classified && source.length ? [{ start: 0, end: source.length, kind: 'source_file', data: { language: 'csharp', capability: 'syntax_only', limitation: 'No Jev classification; localize exact Roslyn operation spans.' } }] : []
        evidence = { sanitized: pieces.join(''), subjects, anchors: [], relationships: [], reasons: ['csharp_framework_relationships_partial'] }
      } else evidence = await parser.context(relative, String(file.language))
    } catch {
      if (source.length) await store.execute('INSERT OR IGNORE INTO review_subjects VALUES (?,NULL,?,?,?,?,?,?)', [hash(JSON.stringify([relative, file.hash, 'unsupported_source'])), relative, 0, source.length, 'unsupported_source', pathPurpose(relative).purpose, '{"capability":"unavailable","reason":"context_parser_limit_or_error"}'])
      await store.execute('INSERT OR REPLACE INTO context_files VALUES (?,?,?,?)', [relative, String(file.hash), 'unavailable', '["context_parser_limit_or_error"]'])
      continue
    }
    if (evidence.sanitized.length !== source.length) throw new Error('context_sanitization_length_mismatch')
    const artifact = await putArtifact(store.root, { sourceHash: file.hash, sanitized: evidence.sanitized })
    await store.execute('INSERT OR REPLACE INTO context_text VALUES (?,?)', [relative, artifact])
    for (let start = 0; start < evidence.sanitized.length; start += 8000) await store.execute('INSERT INTO source_search(file,start,text) VALUES (?,?,?)', [relative, start, evidence.sanitized.slice(start, start + 8200)])
    for (let offset = 0; offset < evidence.anchors.length; offset += 100) await store.batch(evidence.anchors.slice(offset, offset + 100).map(anchor => ({ sql: 'INSERT OR IGNORE INTO source_anchors VALUES (?,?,?,?,?)', params: [relative, anchor.start, anchor.end, anchor.kind, JSON.stringify(anchor.data)] })))
    const functions = await store.query('SELECT id,start,end,purpose FROM functions WHERE file=? ORDER BY start', [relative])
    const known = new Map(functions.map(fn => [`${fn.start}:${fn.end}`, fn]))
    for (const subject of evidence.subjects) {
      const fn = known.get(`${subject.start}:${subject.end}`)
      const purpose = String(fn?.purpose ?? pathPurpose(relative).purpose)
      const id = fn ? String(fn.id) : hash(JSON.stringify([relative, file.hash, subject.start, subject.end, subject.kind]))
      await store.execute('INSERT OR IGNORE INTO review_subjects VALUES (?,?,?,?,?,?,?,?)', [id, fn ? String(fn.id) : null, relative, subject.start, subject.end, fn ? 'function' : subject.kind, purpose, JSON.stringify(subject.data)])
    }
    for (const relation of evidence.relationships) {
      let target = relation.target
      if (target.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target))
        if (!base.startsWith('../') && !path.posix.isAbsolute(base)) {
          for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`]) {
            if ((await store.query('SELECT path FROM files WHERE path=?', [candidate])).length) { target = candidate; break }
          }
        }
      }
      await store.execute('INSERT OR REPLACE INTO relationships VALUES (?,?,?,?,?,?,?)', [hash(JSON.stringify([relative, relation.start, relation.kind, target])), relative, relation.start, relation.end, relation.kind, target, JSON.stringify(relation.data)])
    }
    if (!evidence.subjects.length && !(await store.query('SELECT id FROM functions WHERE file=? LIMIT 1', [relative])).length) evidence.reasons.push('no_reviewable_declarations')
    await store.execute('INSERT OR REPLACE INTO context_files VALUES (?,?,?,?)', [relative, String(file.hash), evidence.reasons.length ? 'partial' : 'indexed', JSON.stringify(evidence.reasons)])
  }
  for await (const file of store.scan('files')) {
    const relative = String(file.path)
    const context = (await store.query('SELECT purpose,data FROM file_context WHERE file=?', [relative]))[0]
    if (!context || !['test_or_fixture', 'example_or_tooling', 'vendor'].includes(String(context.purpose))) continue
    const route = (await store.query(`SELECT r.file,r.start FROM relationships r JOIN file_context origin ON origin.file=r.file
      WHERE r.target=? AND r.kind='route_handler' AND origin.purpose IN ('application_candidate','initialization') LIMIT 1`, [relative]))[0]
    if (!route) continue
    const details = { ...JSON.parse(String(context.data)), purpose: 'application_candidate', originalPathPurpose: context.purpose, declaredRouteReference: { file: route.file, start: route.start }, caveat: 'Declared runtime use overrides a path-only exclusion; execution remains unproven.' }
    await store.batch([
      { sql: "UPDATE file_context SET purpose='application_candidate',data=? WHERE file=?", params: [JSON.stringify(details), relative] },
      { sql: "UPDATE functions SET purpose='application_candidate' WHERE file=?", params: [relative] },
      { sql: "UPDATE review_subjects SET purpose='application_candidate' WHERE file=?", params: [relative] }
    ])
  }
}

export async function searchSnapshot (store: Store, text: string, prefix = '', cursor?: string, limit = 30): Promise<Record<string, unknown>> {
  if (text.length < 3 || text.length > 200 || text.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_search_request')
  if (prefix) relativePath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)
  const generation = await store.get<string>('indexGeneration')
  if (!generation) throw new Error('index_not_ready')
  const query = hash(JSON.stringify([text, prefix]))
  let rowid = 0; let position = 0
  if (cursor) {
    if (cursor.length > 4096) throw new Error('invalid_cursor')
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (value.generation !== generation || value.query !== query || !Number.isSafeInteger(value.rowid) || value.rowid < 0 || !Number.isSafeInteger(value.position) || value.position < 0 || value.position > 8000) throw new Error('stale_or_foreign_cursor')
    rowid = value.rowid; position = value.position
  }
  const rows = await store.query(`SELECT rowid,file,start,text FROM source_search WHERE source_search MATCH ? AND rowid>=? AND substr(file,1,?)=? ORDER BY rowid LIMIT 11`, [`"${text.replaceAll('"', '""')}"`, rowid, prefix.length, prefix])
  const matches: Array<{ file: string, start: number, end: number }> = []
  const encode = (nextRow: number, nextPosition: number) => Buffer.from(JSON.stringify({ generation, query, rowid: nextRow, position: nextPosition })).toString('base64url')
  let next: string | null = null
  for (const row of rows.slice(0, 10)) {
    const body = String(row.text)
    let offset = Number(row.rowid) === rowid ? position : 0
    while ((offset = body.indexOf(text, offset)) >= 0 && offset < 8000) {
      matches.push({ file: String(row.file), start: Number(row.start) + offset, end: Number(row.start) + offset + text.length })
      offset += text.length
      if (matches.length === limit) { next = encode(Number(row.rowid), Math.min(8000, offset)); break }
    }
    if (next) break
  }
  if (!next && rows.length > 10) next = encode(Number(rows[10]!.rowid), 0)
  const gaps = Number((await store.query("SELECT COUNT(*) AS count FROM files f LEFT JOIN context_files c ON c.file=f.path WHERE c.file IS NULL OR c.capability!='indexed'"))[0]!.count)
  return { matches, cursor: next, completion: next || gaps ? 'partial' : 'complete', unindexedOrPartialFiles: gaps, reasons: ['literal_matches_not_dataflow', ...(next ? ['page_budget'] : [])] }
}

export async function contextPage (store: Store, file: string, kind: 'anchors' | 'relationships', cursor?: string): Promise<Record<string, unknown>> {
  relativePath(file)
  if (!(await store.query('SELECT path FROM files WHERE path=?', [file])).length) throw new Error('source_outside_snapshot')
  const generation = await store.get<string>('indexGeneration')
  if (!generation) throw new Error('index_not_ready')
  const query = hash(JSON.stringify([file, kind]))
  let after = 0
  if (cursor) {
    if (cursor.length > 4096) throw new Error('invalid_cursor')
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (value.query !== query || value.generation !== generation || !Number.isSafeInteger(value.after) || value.after < 0) throw new Error('stale_or_foreign_cursor')
    after = value.after
  }
  const rows = kind === 'anchors'
    ? await store.query('SELECT rowid,file,start,end,kind,data FROM source_anchors WHERE file=? AND rowid>? ORDER BY rowid LIMIT 51', [file, after])
    : await store.query('SELECT rowid,file,start,end,kind,target,data FROM relationships WHERE (file=? OR target=?) AND rowid>? ORDER BY rowid LIMIT 51', [file, file, after])
  const page = rows.slice(0, 50)
  return { rows: page.map(row => ({ ...row, data: JSON.parse(String(row.data)) })), cursor: rows.length > 50 ? Buffer.from(JSON.stringify({ generation, query, after: page.at(-1)!.rowid })).toString('base64url') : null, completion: 'partial', reasons: ['declared_relationships_not_execution_or_dataflow_proof'], purpose: (await store.query('SELECT purpose,data FROM file_context WHERE file=?', [file]))[0] ?? null }
}