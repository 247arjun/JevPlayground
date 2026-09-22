import path from 'node:path'
import ts from 'typescript'
import { defaultLimits } from '../domain.js'
import { hash, readBounded } from '../security.js'
import { Store, type Operation } from '../storage/store.js'
import { withRunLock } from '../storage/lock.js'
import { syntaxIndex } from './syntax.js'
import { CSharp } from './csharp.js'
import { SyntaxWorker } from './syntax-client.js'

const indexVersion = 'syntax-v5'

export async function buildIndex (run: string, reuseRun?: string): Promise<Record<string, unknown>> {
  if (reuseRun && path.resolve(reuseRun) === path.resolve(run)) throw new Error('reuse_run_must_be_different')
  return await withRunLock(run, async () => {
    const store = await Store.open(run)
    const csharp = new CSharp(path.join(run, 'snapshot/source'))
    const syntax = new SyntaxWorker(path.join(run, 'snapshot/source'))
    let previousStore: Store | undefined
    try {
      if (!await store.get('importComplete')) throw new Error('import_not_complete')
      const snapshotId = await store.get<string>('snapshotId')
      const generation = hash(JSON.stringify([snapshotId, indexVersion, ts.version, 'roslyn-4.11.0']))
      const previousStats = await store.get<{ incompleteFiles?: number }>('indexStats')
      if (await store.get('indexGeneration') === generation && !previousStats?.incompleteFiles) return { status: 'already_indexed', generation }
      await store.set('indexGeneration', null)
      if (await store.get('indexBuilding') !== generation) {
        await store.batch(['calls', 'registrations', 'projects', 'semantic_results', 'coverage', 'index_batches'].map(table => ({ sql: `DELETE FROM ${table}` })))
        await store.set('indexBuilding', generation)
      }
      await store.set('indexVersion', indexVersion)
      if (reuseRun) {
        previousStore = await Store.open(path.resolve(reuseRun))
        if (await previousStore.get('indexVersion') !== indexVersion || !await previousStore.get('indexGeneration')) throw new Error('reuse_index_incompatible')
      }
      let reusedFiles = 0; let reusedFromPrevious = 0; let parsedFiles = 0
      for await (const file of store.scan('files')) {
        const relative = String(file.path)
        const done = (await store.query('SELECT hash FROM index_batches WHERE generation=? AND file=?', [generation, relative]))[0]
        if (done?.hash === file.hash) { reusedFiles++; continue }
        const bytes = await readBounded(path.join(run, 'snapshot/source'), relative, defaultLimits.maxFileBytes)
        if (hash(bytes) !== file.hash) throw new Error('snapshot_hash_mismatch')
        await store.batch([
          { sql: 'DELETE FROM calls WHERE file=?', params: [relative] },
          { sql: 'DELETE FROM registrations WHERE file=?', params: [relative] },
          { sql: 'DELETE FROM projects WHERE file=?', params: [relative] }
        ])
        if (previousStore && ['tsjs', 'csharp'].includes(String(file.language))) {
          const old = (await previousStore.query('SELECT files.hash,coverage.capability,coverage.reasons FROM files JOIN coverage ON coverage.scope=files.path WHERE files.path=?', [relative]))[0]
          if (old?.hash === file.hash && old.capability !== 'unavailable') {
            for (const table of ['calls', 'registrations'] as const) {
              let after = ''
              while (true) {
                const rows = await previousStore.query(`SELECT * FROM ${table} WHERE file=? AND id>? ORDER BY id LIMIT 50`, [relative, after])
                if (!rows.length) break
                await store.batch(rows.map(row => table === 'calls'
                  ? { sql: 'INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)', params: [row.id!, row.file!, row.start!, row.end!, row.caller_id!, row.name!, row.expression!, row.data!] }
                  : { sql: 'INSERT INTO registrations VALUES (?,?,?,?,?)', params: [row.id!, row.file!, row.start!, row.kind!, row.data!] }))
                after = String(rows.at(-1)!.id)
              }
            }
            await store.execute('INSERT OR REPLACE INTO coverage VALUES (?,?,?)', [relative, String(old.capability), String(old.reasons)])
            await store.execute('INSERT OR REPLACE INTO index_batches VALUES (?,?,?)', [generation, relative, String(file.hash)])
            reusedFromPrevious++
            continue
          }
        }
        if (/(^|\/)tsconfig[^/]*\.json$/.test(relative)) {
          const parsed = ts.parseConfigFileTextToJson(relative, bytes.toString())
          await store.execute('INSERT INTO projects VALUES (?,?,?,?,?,?)', [relative, relative, 'tsjs', hash(JSON.stringify([snapshotId, file.hash, ts.version])), 'syntax_only', JSON.stringify(parsed.error ? ['configuration_parse_error'] : [])])
        }
        if (/\.csproj$/.test(relative)) await store.execute('INSERT INTO projects VALUES (?,?,?,?,?,?)', [relative, relative, 'csharp', hash(JSON.stringify([snapshotId, file.hash, 'roslyn-4.11.0'])), 'semantic_partial', JSON.stringify(['build_configuration_not_evaluated'])])
        let result: ReturnType<typeof syntaxIndex>
        if (file.language === 'csharp') {
          try { result = await csharp.request('analyze', { file: relative }) as ReturnType<typeof syntaxIndex> } catch {
            await store.execute('INSERT OR REPLACE INTO coverage VALUES (?,?,?)', [relative, 'unavailable', JSON.stringify(['csharp_sidecar_unavailable'])])
            continue
          }
        } else if (file.language === 'tsjs') {
          try { result = await syntax.index(relative) } catch {
            await store.execute('INSERT OR REPLACE INTO coverage VALUES (?,?,?)', [relative, 'unavailable', JSON.stringify(['syntax_resource_limit_or_failure'])])
            continue
          }
        } else {
          await store.execute('INSERT OR REPLACE INTO index_batches VALUES (?,?,?)', [generation, relative, String(file.hash)])
          continue
        }
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
        await store.execute('INSERT OR REPLACE INTO index_batches VALUES (?,?,?)', [generation, relative, String(file.hash)])
        parsedFiles++
      }
      const files = Number((await store.query("SELECT COUNT(*) AS count FROM coverage WHERE capability!='unavailable'"))[0]!.count)
      const callCount = Number((await store.query('SELECT COUNT(*) AS count FROM calls'))[0]!.count)
      const incompleteFiles = Number((await store.query('SELECT COUNT(*) AS count FROM files WHERE NOT EXISTS (SELECT 1 FROM index_batches WHERE index_batches.generation=? AND index_batches.file=files.path)', [generation]))[0]!.count)
      await store.set('indexGeneration', generation)
      await store.set('indexStats', { files, calls: callCount, generation, reusedFiles, reusedFromPrevious, parsedFiles, incompleteFiles, semanticReuse: 'invalidated_for_new_snapshot' })
      if (!incompleteFiles) await store.set('indexBuilding', null)
      return { status: incompleteFiles ? 'partial' : 'indexed', files, calls: callCount, generation, reusedFiles, reusedFromPrevious, parsedFiles, incompleteFiles }
    } finally { syntax.close(); csharp.close(); await previousStore?.close(); await store.close() }
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