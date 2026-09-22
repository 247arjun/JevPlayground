import path from 'node:path'
import { defaultLimits } from '../domain.js'
import { hash, readBounded } from '../security.js'
import { Store } from '../storage/store.js'
import { callPage } from './index.js'
import { localEvidence } from './syntax.js'
import { Workspaces } from './workspaces.js'
import { CSharp } from './csharp.js'

export class Navigation {
  readonly workspaces: Workspaces
  readonly csharp: CSharp
  constructor (readonly store: Store) {
    this.workspaces = new Workspaces(path.join(store.root, 'snapshot/source'))
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
  async inspect (file: string, start: number, end: number): Promise<unknown> {
    const row = (await this.store.query('SELECT hash FROM files WHERE path=?', [file]))[0]
    if (!row) throw new Error('file_not_indexed')
    const source = (await readBounded(path.join(this.store.root, 'snapshot/source'), file, defaultLimits.maxFileBytes)).toString()
    if (hash(source) !== row.hash) throw new Error('snapshot_hash_mismatch')
    if (/\.cs$/.test(file)) {
      const parsed = await this.csharp.request('analyze', { file }) as { calls: Array<{ start: number, end: number }> }
      return { operations: parsed.calls.filter(call => call.start >= start && call.end <= end).slice(0, 100), capability: 'syntax_only', completion: 'partial', reasons: ['guard_and_reaching_definition_analysis_not_available'] }
    }
    return localEvidence(file, source, start, end)
  }
  close (): void { this.workspaces.close(); this.csharp.close() }
}