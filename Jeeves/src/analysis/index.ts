import path from 'node:path'
import ts from 'typescript'
import { defaultLimits } from '../domain.js'
import { hash, readBounded } from '../security.js'
import { Store, type Operation } from '../storage/store.js'
import { withRunLock } from '../storage/lock.js'
import { syntaxIndex } from './syntax.js'

export async function buildIndex (run: string): Promise<Record<string, unknown>> {
  return await withRunLock(run, async () => {
    const store = await Store.open(run)
    try {
      if (!await store.get('importComplete')) throw new Error('import_not_complete')
      const snapshotId = await store.get<string>('snapshotId')
      const generation = hash(JSON.stringify([snapshotId, 'syntax-v1', ts.version]))
      if (await store.get('indexGeneration') === generation) return { status: 'already_indexed', generation }
      await store.set('indexGeneration', null)
      await store.batch(['calls', 'registrations', 'projects', 'semantic_results', 'coverage'].map(table => ({ sql: `DELETE FROM ${table}` })))
      let files = 0; let callCount = 0
      for await (const file of store.scan('files')) {
        const relative = String(file.path)
        const bytes = await readBounded(path.join(run, 'snapshot/source'), relative, defaultLimits.maxFileBytes)
        if (hash(bytes) !== file.hash) throw new Error('snapshot_hash_mismatch')
        if (/(^|\/)tsconfig[^/]*\.json$/.test(relative)) {
          const parsed = ts.parseConfigFileTextToJson(relative, bytes.toString())
          await store.execute('INSERT INTO projects VALUES (?,?,?,?,?,?)', [relative, relative, 'tsjs', hash(JSON.stringify([snapshotId, file.hash, ts.version])), 'syntax_only', JSON.stringify(parsed.error ? ['configuration_parse_error'] : [])])
        }
        if (file.language === 'csharp') {
          await store.execute('INSERT OR REPLACE INTO coverage VALUES (?,?,?)', [relative, 'syntax_only', JSON.stringify(['csharp_sidecar_required'])])
          continue
        }
        if (file.language !== 'tsjs') continue
        const result = syntaxIndex(relative, bytes.toString())
        let operations: Operation[] = []
        async function flush () { if (operations.length) { await store.batch(operations); operations = [] } }
        for (const site of result.calls) {
          operations.push({ sql: 'INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)', params: [site.id, site.file, site.start, site.end, site.callerId, site.name, site.expression, JSON.stringify(site.data)] })
          if (operations.length >= 100) await flush()
        }
        await flush()
        for (const registration of result.registrations) {
          operations.push({ sql: 'INSERT INTO registrations VALUES (?,?,?,?,?)', params: [registration.id, registration.file, registration.start, registration.kind, JSON.stringify(registration.data)] })
          if (operations.length >= 100) await flush()
        }
        await flush()
        await store.execute('INSERT OR REPLACE INTO coverage VALUES (?,?,?)', [relative, 'syntax_only', JSON.stringify(result.diagnostics.length ? ['parse_error'] : ['semantic_resolution_deferred'])])
        files++; callCount += result.calls.length
      }
      await store.set('indexGeneration', generation)
      await store.set('indexStats', { files, calls: callCount, generation })
      return { status: 'indexed', files, calls: callCount, generation }
    } finally { await store.close() }
  })
}

type Cursor = { generation: string, query: string, after: string }
export async function callPage (store: Store, name: string, cursor?: string, limit = 50): Promise<Record<string, unknown>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || name.length > 1024) throw new Error('invalid_page_request')
  const generation = await store.get<string>('indexGeneration')
  if (!generation) throw new Error('index_not_ready')
  const query = hash(JSON.stringify(['callers_by_name', name]))
  let after = ''
  if (cursor) {
    if (cursor.length > 4096) throw new Error('invalid_cursor')
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Cursor
    if (parsed.generation !== generation || parsed.query !== query || typeof parsed.after !== 'string') throw new Error('stale_or_foreign_cursor')
    after = parsed.after
  }
  const rows = await store.query('SELECT * FROM calls WHERE name=? AND id>? ORDER BY id LIMIT ?', [name, after, limit + 1])
  const page = []
  let bytes = 0
  for (const row of rows.slice(0, limit)) {
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (bytes > defaultLimits.maxResultBytes) break
    page.push(row)
  }
  if (!page.length && rows.length) throw new Error('single_result_exceeds_budget')
  const hasMore = page.length < rows.length
  return { rows: page, cursor: hasMore ? Buffer.from(JSON.stringify({ generation, query, after: page.at(-1)!.id })).toString('base64url') : null,
    generation, capability: 'syntax_only', completion: 'partial', reasons: ['name_candidates_not_all_callers', 'unresolved_dispatch', ...(hasMore ? ['page_budget'] : [])], returnedBytes: bytes }
}