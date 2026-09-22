import { lstat, mkdir, chmod, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SQLInputValue } from 'node:sqlite'
import type { Row } from '../domain.js'
import { atomicJson, hash, readBounded } from '../security.js'

export type Operation = { sql: string, params?: SQLInputValue[], mode?: 'all' | 'get' | 'run' }

// SQL is code-owned only. Agents use higher-level scoped tools, never this API.
export class Store {
  private sequence = 0
  private pending = new Map<number, { resolve: (value: unknown[]) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>()
  private worker: Worker
  private ready: Promise<void>
  private dead = false
  constructor (readonly root: string) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { execArgv: [], workerData: { file: path.join(root, 'state.sqlite') } })
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('error', reject)
      this.worker.on('message', message => {
        if (message.ready) { resolve(); return }
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.value)
      })
    })
    const fail = () => {
      this.dead = true
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('database_worker_unavailable')) }
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', fail)
  }
  static async open (root: string): Promise<Store> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    if ((await lstat(root)).isSymbolicLink()) throw new Error('symlink_not_allowed')
    for (const name of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      try { if ((await lstat(path.join(root, name))).isSymbolicLink()) throw new Error('symlink_not_allowed') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const store = new Store(root)
    await store.ready
    await chmod(path.join(root, 'state.sqlite'), 0o600)
    return store
  }
  private async send (kind: string, operations: Operation[] = []): Promise<unknown[]> {
    await this.ready
    if (this.dead) throw new Error('database_worker_unavailable')
    if (this.pending.size >= 32 || operations.length > 500 || Buffer.byteLength(JSON.stringify(operations)) > 4 * 1024 * 1024) throw new Error('database_backpressure')
    return await new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        // Terminating a stuck worker is safer than accepting late writes after a
        // caller has assumed its transaction failed. SQLite recovers its journal.
        void this.worker.terminate()
        reject(new Error('database_timeout'))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, kind, operations })
    })
  }
  async query (sql: string, params: SQLInputValue[] = []): Promise<Row[]> {
    return (await this.send('query', [{ sql, params, mode: 'all' }]))[0] as Row[]
  }
  async execute (sql: string, params: SQLInputValue[] = []): Promise<void> { await this.send('query', [{ sql, params }]) }
  async batch (operations: Operation[]): Promise<unknown[]> { return await this.send('batch', operations) }
  async set (key: string, value: unknown): Promise<void> { await this.execute('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]) }
  async get<T> (key: string): Promise<T | undefined> {
    const row = (await this.query('SELECT value FROM meta WHERE key=?', [key]))[0]
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  async * scan (table: 'files' | 'functions' | 'tasks' | 'projects' | 'calls'): AsyncGenerator<Row> {
    const key = table === 'files' ? 'path' : 'id'
    let after = ''
    while (true) {
      const rows = await this.query(`SELECT * FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 128`, [after])
      if (!rows.length) return
      for (const row of rows) yield row
      after = String(rows.at(-1)![key])
    }
  }
  async close (): Promise<void> { if (!this.dead) await this.send('close'); await this.worker.terminate() }
}

export async function putArtifact (root: string, value: unknown): Promise<string> {
  const digest = hash(JSON.stringify(value))
  await atomicJson(path.join(root, 'artifacts', digest.slice(0, 2), `${digest}.json`), value)
  return digest
}

export async function getArtifact<T> (root: string, digest: string): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_artifact_hash')
  const value = JSON.parse((await readBounded(root, `artifacts/${digest.slice(0, 2)}/${digest}.json`, 32 * 1024 * 1024)).toString()) as T
  if (hash(JSON.stringify(value)) !== digest) throw new Error('artifact_hash_mismatch')
  return value
}