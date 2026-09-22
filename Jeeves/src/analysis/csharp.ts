import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const sidecarPath = fileURLToPath(new URL('../../../dotnet/Jeeves.AnalysisHost/bin/Release/net8.0/Jeeves.AnalysisHost.dll', import.meta.url))

export class CSharp {
  private child?: ChildProcessWithoutNullStreams
  private sequence = 0
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private buffer = ''
  private waiting?: { id: number, resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }
  constructor (readonly root: string) {}
  async request (method: string, fields: Record<string, unknown>): Promise<unknown> {
    if (!existsSync(sidecarPath)) throw new Error('csharp_sidecar_not_built')
    if (++this.queued > 16) { this.queued--; throw new Error('compiler_backpressure') }
    const operation = this.tail.then(async () => await this.send(method, fields))
    this.tail = operation.catch(() => {})
    try { return await operation } finally { this.queued-- }
  }
  private async send (method: string, fields: Record<string, unknown>): Promise<unknown> {
    if (!this.child) {
      this.child = spawn('dotnet', [sidecarPath], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTNET_GCHeapHardLimit: '20000000', DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } })
      const child = this.child
      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk
        if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.close(); return }
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) return
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        try {
          const response = JSON.parse(line) as { id: number, value: unknown, error?: string }
          const pending = this.waiting
          if (!pending || response.id !== pending.id) return
          clearTimeout(pending.timer); this.waiting = undefined
          if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.value)
        } catch { this.close() }
      })
      this.child.stderr.resume()
      this.child.once('error', () => { if (this.child === child) this.close() })
      this.child.once('exit', () => { if (this.child === child) this.close() })
    }
    return await new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.close() }, 30000)
      this.waiting = { id, resolve, reject, timer }
      this.child!.stdin.write(JSON.stringify({ id, method, root: this.root, ...fields }) + '\n')
    })
  }
  close (): void {
    const child = this.child; this.child = undefined; this.buffer = ''
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting.reject(new Error('csharp_worker_unavailable')); this.waiting = undefined }
    child?.kill('SIGKILL')
  }
}