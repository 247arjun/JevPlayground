import path from 'node:path'
import { defaultLimits, type Limits } from '../domain.js'
import { hash, readBounded } from '../security.js'
import { Store } from '../storage/store.js'
import { callPage } from './index.js'
import { localEvidence, traceLocalValue } from './syntax.js'
import { Workspaces } from './workspaces.js'
import { CSharp } from './csharp.js'

export class Navigation {
  readonly workspaces: Workspaces
  readonly csharp: CSharp
  constructor (readonly store: Store, limits: Limits = defaultLimits) {
    this.workspaces = new Workspaces(path.join(store.root, 'snapshot/source'), limits)
    this.csharp = new CSharp(path.join(store.root, 'snapshot/source'))
  }
  async resolve (file: string, start: number, project: string): Promise<unknown> {
    const snapshotId = await this.store.get<string>('snapshotId')
    const context = (await this.store.query('SELECT * FROM projects WHERE id=?', [project]))[0]
    if (!context) throw new Error('project_not_indexed')
    const key = hash(JSON.stringify([snapshotId, context.fingerprint, file, start, 'resolver-v1']))
    const cached = (await this.store.query('SELECT data FROM semantic_results WHERE key=?', [key]))[0]
    if (cached) return JSON.parse(String(cached.data))
    const result = context.language === 'csharp'
      ? await this.csharp.request('resolve', { project, file, start })
      : await this.workspaces.resolve(project, file, start)
    await this.store.execute('INSERT OR REPLACE INTO semantic_results VALUES (?,?,?)', [key, project, JSON.stringify(result)])
    return result
  }
  async callers (functionId: string, cursor?: string, limit = 50): Promise<unknown> {
    const target = (await this.store.query('SELECT name,file FROM functions WHERE id=?', [functionId]))[0]
    if (!target) throw new Error('function_not_found')
    return await callPage(this.store, String(target.name), cursor, limit)
  }
  async semanticCallers (functionId: string, project: string, cursor?: string, limit = 25): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_page_request')
    const generation = await this.store.get<string>('indexGeneration')
    const context = (await this.store.query('SELECT * FROM projects WHERE id=?', [project]))[0]
    if (!generation || !context) throw new Error('project_not_indexed')
    if (!(await this.store.query('SELECT id FROM functions WHERE id=?', [functionId])).length) throw new Error('function_not_found')
    const query = hash(JSON.stringify([functionId, project, context.fingerprint, 'semantic-callers-v1']))
    let position: unknown
    if (cursor) {
      if (cursor.length > 8192) throw new Error('invalid_cursor')
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { generation: string, query: string, position: { file: string, ordinal: number } }
      if (parsed.generation !== generation || parsed.query !== query || typeof parsed.position?.file !== 'string' || !Number.isInteger(parsed.position.ordinal) || parsed.position.ordinal < -1) throw new Error('stale_or_foreign_cursor')
      position = parsed.position
    }
    if (context.language !== 'tsjs') return { rows: [], cursor: null, capability: 'semantic_partial', completion: 'blocked', reasons: ['csharp_reverse_resolution_not_available'] }
    const key = hash(JSON.stringify([query, generation, position, limit]))
    const cached = (await this.store.query('SELECT data FROM semantic_results WHERE key=?', [key]))[0]
    if (cached) return JSON.parse(String(cached.data))
    const resolved = await this.workspaces.callers(project, functionId, position, limit) as Record<string, unknown>
    const result = { ...resolved, generation, searchedProject: project,
      cursor: resolved.cursor ? Buffer.from(JSON.stringify({ generation, query, position: resolved.cursor })).toString('base64url') : null }
    await this.store.execute('INSERT OR REPLACE INTO semantic_results VALUES (?,?,?)', [key, project, JSON.stringify(result)])
    return result
  }
  async inspect (file: string, start: number, end: number): Promise<unknown> {
    const row = (await this.store.query('SELECT hash FROM files WHERE path=?', [file]))[0]
    if (!row) throw new Error('file_not_indexed')
    const source = (await readBounded(path.join(this.store.root, 'snapshot/source'), file, defaultLimits.maxFileBytes)).toString()
    if (hash(source) !== row.hash) throw new Error('snapshot_hash_mismatch')
    if (/\.cs$/.test(file)) {
      return await this.csharp.request('local', { file, start, end })
    }
    return localEvidence(file, source, start, end)
  }
  async trace (file: string, offset: number): Promise<unknown> {
    const row = (await this.store.query('SELECT hash FROM files WHERE path=?', [file]))[0]
    if (!row) throw new Error('file_not_indexed')
    const source = (await readBounded(path.join(this.store.root, 'snapshot/source'), file, defaultLimits.maxFileBytes)).toString()
    if (hash(source) !== row.hash) throw new Error('snapshot_hash_mismatch')
    if (/\.cs$/.test(file)) return await this.csharp.request('trace', { file, start: offset })
    return traceLocalValue(file, source, offset)
  }
  async registrations (file: string, after = ''): Promise<unknown> {
    if (!(await this.store.query('SELECT path FROM files WHERE path=?', [file])).length) throw new Error('file_not_indexed')
    const rows = await this.store.query('SELECT * FROM registrations WHERE file=? AND id>? ORDER BY id LIMIT 50', [file, after])
    return { rows, next: rows.length === 50 ? rows.at(-1)!.id : null, capability: 'syntax_only', completion: 'partial', reasons: ['registration_is_not_invocation', 'receiver_identity_and_execution_order_require_verification'] }
  }
  close (): void { this.workspaces.close(); this.csharp.close() }
}