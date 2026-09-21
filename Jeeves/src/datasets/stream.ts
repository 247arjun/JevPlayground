import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { compose, Transform } from 'node:stream'
import parser from 'stream-json'
import Pick from 'stream-json/filters/Pick.js'
import StreamArray from 'stream-json/streamers/StreamArray.js'
import { containedFile } from '../security.js'

export async function fileHash (root: string, relative: string): Promise<string> {
  const digest = createHash('sha256')
  const handle = await open(await containedFile(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  for await (const chunk of handle.createReadStream()) digest.update(chunk)
  return digest.digest('hex')
}

// JSON token limits apply before object assembly, including oversized strings.
// Streaming the array alone would still allow a single record to exhaust memory.
function tokenLimit (): Transform {
  let depth = 0
  let bytes = 0
  return new Transform({ objectMode: true, transform (token: { name: string, value?: unknown }, _encoding, callback) {
    if (token.name === 'startObject' || token.name === 'startArray') depth++
    bytes += typeof token.value === 'string' ? Buffer.byteLength(token.value) : 8
    if (depth > 100 || bytes > 32 * 1024 * 1024) { callback(new Error('json_record_limit')); return }
    this.push(token)
    if (token.name === 'endObject' || token.name === 'endArray') { depth--; if (depth === 1) bytes = 0 }
    callback()
  } })
}

export async function * jsonArray (root: string, relative: string, property?: string): AsyncGenerator<unknown> {
  const handle = await open(await containedFile(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  const input = handle.createReadStream({ highWaterMark: 65536 })
  const stream = property
    ? compose(input, parser.parser(), Pick.pick({ filter: property }), tokenLimit(), StreamArray.streamArray())
    : compose(input, parser.parser(), tokenLimit(), StreamArray.streamArray())
  try {
    for await (const entry of stream) yield (entry as { value: unknown }).value
  } finally { stream.destroy() }
}

export async function * jsonLines (root: string, relative: string): AsyncGenerator<unknown> {
  const handle = await open(await containedFile(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  const input = handle.createReadStream({ encoding: 'utf8', highWaterMark: 65536 })
  let pending = ''
  try {
    for await (const chunk of input) {
      pending += String(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        if (line.length > 32 * 1024 * 1024) throw new Error('json_record_limit')
        pending = pending.slice(newline + 1)
        if (line.trim()) yield JSON.parse(line)
      }
      if (pending.length > 32 * 1024 * 1024) throw new Error('json_record_limit')
    }
    if (pending.trim()) yield JSON.parse(pending)
  } finally { input.destroy() }
}