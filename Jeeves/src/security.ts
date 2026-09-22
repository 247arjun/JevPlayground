import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export function hash (value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function relativePath (value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.isAbsolute(value) ||
      /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid_relative_path')
  }
  return value
}

export async function canonicalOutput (file: string): Promise<string> {
  let existing = path.resolve(file)
  const suffix: string[] = []
  while (true) {
    try { return path.join(await realpath(existing), ...suffix) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      suffix.unshift(path.basename(existing))
      const parent = path.dirname(existing)
      if (parent === existing) throw new Error('output_parent_unavailable')
      existing = parent
    }
  }
}

// Reject symlinks at every component, even links that currently point inside the
// root. Inputs are immutable snapshots, not live user-controlled filesystem trees.
export async function containedFile (root: string, relative: string): Promise<string> {
  relativePath(relative)
  const base = await realpath(root)
  let current = base
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink_not_allowed')
  }
  if (!(await lstat(current)).isFile()) throw new Error('not_a_regular_file')
  return current
}

export async function readBounded (root: string, relative: string, maxBytes: number): Promise<Buffer> {
  const file = await containedFile(root, relative)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const size = (await handle.stat()).size
    if (size > maxBytes) throw new Error('file_size_limit')
    const buffer = Buffer.alloc(Math.min(size + 1, maxBytes + 1))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > size || offset > maxBytes) throw new Error('file_changed_during_read')
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

export async function atomicJson (file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
}

export function errorCode (error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Never surface SDK error bodies or arbitrary exception messages as CLI logs.
  return /^[a-z][a-z0-9_]{1,80}$/.test(message) ? message : 'operation_failed'
}