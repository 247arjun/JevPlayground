import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultLimits, type Limits } from '../domain.js'

type Waiter = { key: string, action: () => Promise<unknown>, resolve: (value: unknown) => void, reject: (error: Error) => void }
export class Workspaces {
  private queue: Waiter[] = []
  private inflight = new Map<string, Promise<unknown>>()
  private running = false
  private child?: ChildProcess
  private project = ''
  private sequence = 0
  private idle?: NodeJS.Timeout
  private closed = false
  readonly metrics = { loads: 0, cacheHits: 0, coalesced: 0, evictions: 0, maxResident: 0, lastRss: 0 }
  constructor (private readonly root: string, private readonly limits: Limits = defaultLimits) {}

  async resolve (project: string, file: string, start: number): Promise<unknown> {
    return await this.request(project, 'resolve', { file, start })
  }
  async callers (project: string, targetId: string, cursor: unknown, limit: number): Promise<unknown> {
    return await this.request(project, 'callers', { targetId, cursor, limit })
  }
  private async request (project: string, method: string, fields: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('workspace_pool_closed')
    const key = JSON.stringify([project, method, fields])
    const existing = this.inflight.get(key)
    if (existing) { this.metrics.coalesced++; return await existing }
    if (this.queue.length >= this.limits.maxQueue) throw new Error('compiler_backpressure')
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject, action: async () => {
        clearTimeout(this.idle)
        if (this.project !== project || !this.child?.connected) {
          this.evict()
          this.child = fork(fileURLToPath(new URL('./semantic-worker.js', import.meta.url)), [], {
            execArgv: [`--max-old-space-size=${this.limits.compilerMemoryMb}`],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH }
          })
          this.project = project
          await this.rpc('load', { project })
          this.metrics.loads++; this.metrics.maxResident = 1
        } else this.metrics.cacheHits++
        const result = await this.rpc(method, fields)
        this.idle = setTimeout(() => this.evict(), 30000).unref()
        return result
      } })
    })
    this.inflight.set(key, promise)
    void this.pump()
    return await promise
  }
  private async pump (): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!
        try { next.resolve(await next.action()) } catch (error) { this.evict(); next.reject(error instanceof Error ? error : new Error('compiler_failed')) }
        finally { this.inflight.delete(next.key) }
      }
    } finally { this.running = false }
  }
  private async rpc (method: string, fields: Record<string, unknown>): Promise<unknown> {
    const child = this.child!
    return await new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { cleanup(); this.evict(); reject(new Error('compiler_timeout')) }, this.limits.compilerTimeoutMs)
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('error', exited) }
      const exited = () => { cleanup(); reject(new Error('compiler_worker_unavailable')) }
      const receive = (message: unknown) => {
        const response = message as { id: number, error?: string, value?: { memoryRss?: number } }
        if (response.id !== id) return
        cleanup()
        if (response.error) { reject(new Error(response.error)); return }
        this.metrics.lastRss = response.value?.memoryRss ?? 0
        if (this.metrics.lastRss > this.limits.compilerMemoryMb * 1024 * 1024 * 2) { this.evict(); reject(new Error('resource_limited')); return }
        if (Buffer.byteLength(JSON.stringify(response.value)) > this.limits.maxResultBytes) { reject(new Error('semantic_result_limit')); return }
        resolve(response.value)
      }
      child.on('message', receive); child.once('exit', exited); child.once('error', exited)
      child.send({ id, method, root: this.root, ...fields })
    })
  }
  private evict (): void {
    clearTimeout(this.idle)
    if (this.child) { this.child.kill('SIGKILL'); this.child = undefined; this.metrics.evictions++ }
    this.project = ''
  }
  close (): void {
    this.closed = true
    for (const pending of this.queue.splice(0)) { this.inflight.delete(pending.key); pending.reject(new Error('workspace_pool_closed')) }
    this.evict()
  }
}