import { Worker } from 'node:worker_threads'
import type { syntaxIndex } from './syntax.js'
import type { ContextEvidence } from './context.js'

export class SyntaxWorker {
  private worker?: Worker
  private sequence = 0
  private busy = false
  constructor (private readonly root: string) {}
  async index (file: string): Promise<ReturnType<typeof syntaxIndex>> {
    return await this.request(file, 'syntax')
  }
  async context (file: string, language: string): Promise<ContextEvidence> {
    return await this.request(file, 'context', language)
  }
  private async request<Result> (file: string, kind: string, language?: string): Promise<Result> {
    if (this.busy) throw new Error('syntax_worker_busy')
    this.busy = true
    this.worker ??= new Worker(new URL('./syntax-worker.js', import.meta.url), { execArgv: [], workerData: { root: this.root }, resourceLimits: { maxOldGenerationSizeMb: 192 } })
    const worker = this.worker
    try {
      return await new Promise((resolve, reject) => {
        const id = ++this.sequence
        const cleanup = () => { clearTimeout(timer); worker.off('message', receive); worker.off('error', failed); worker.off('exit', failed) }
        const failed = () => { cleanup(); this.worker = undefined; reject(new Error('syntax_worker_failed')) }
        const receive = (message: { id: number, error?: string, value: Result }) => {
          if (message.id !== id) return
          cleanup()
          if (message.error) reject(new Error(message.error)); else resolve(message.value)
        }
        const timer = setTimeout(() => { cleanup(); this.close(); reject(new Error('syntax_timeout')) }, 30000)
        worker.once('error', failed); worker.once('exit', failed); worker.on('message', receive)
        worker.postMessage({ id, file, kind, language })
      })
    } finally { this.busy = false }
  }
  close (): void { if (this.worker) void this.worker.terminate(); this.worker = undefined }
}