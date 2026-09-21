import { randomUUID } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

export async function withRunLock<T> (root: string, action: () => Promise<T>): Promise<T> {
  const file = path.join(root, '.coordinator.lock')
  const owner = { token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() }
  const handle = await open(file, 'wx', 0o600).catch(() => { throw new Error('run_locked') })
  try {
    await handle.writeFile(JSON.stringify(owner))
    await handle.sync()
    return await action()
  } finally {
    await handle.close()
    const current = JSON.parse(await readFile(file, 'utf8')) as { token: string }
    if (current.token === owner.token) await rm(file)
  }
}

export async function recoverLock (root: string): Promise<void> {
  const file = path.join(root, '.coordinator.lock')
  const owner = JSON.parse(await readFile(file, 'utf8')) as { pid: number, token: string }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('invalid_lock')
  try { process.kill(owner.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(file); return }
    throw error
  }
  throw new Error('lock_owner_alive')
}