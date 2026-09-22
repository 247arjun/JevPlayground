import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store } from './storage/store.js'
import { callPage } from './analysis/index.js'

export async function benchmark (count = 10000): Promise<Record<string, unknown>> {
  if (!Number.isInteger(count) || count < 100 || count > 100000) throw new Error('invalid_benchmark_size')
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-scale-')); const store = await Store.open(root)
  const started = performance.now(); let peakRss = process.memoryUsage().rss
  try {
    await store.set('indexGeneration', 'benchmark')
    for (let start = 0; start < count; start += 100) {
      await store.batch(Array.from({ length: Math.min(100, count - start) }, (_, index) => ({ sql: 'INSERT INTO calls VALUES (?,?,?,?,?,?,?,?)', params: [String(start + index).padStart(8, '0'), 'code.ts', start + index, start + index + 1, null, 'shared', 'shared', '{}'] })))
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }
    let returned = 0; let pages = 0; let cursor: string | undefined; let last = ''
    do {
      const page = await callPage(store, 'shared', cursor, 100)
      const rows = page.rows as Array<{ id: string }>
      assert.ok(rows.length <= 100)
      for (const row of rows) { assert.ok(row.id > last); last = row.id; returned++ }
      assert.ok(Number(page.returnedBytes) <= 96 * 1024)
      pages++; cursor = page.cursor as string | undefined
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    } while (cursor)
    assert.equal(returned, count)
    const plan = await store.query('EXPLAIN QUERY PLAN SELECT * FROM calls WHERE name=? AND id>? ORDER BY id LIMIT ?', ['shared', '', 100])
    assert.ok(JSON.stringify(plan).includes('calls_name'))
    return { calls: count, returned, pages, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), nodeProcessPeakRssBytes: peakRss, memoryMeasurement: 'Main process including database worker; excludes semantic child processes', hardware: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version }, indexedLookup: true }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await benchmark(Number(process.argv[2] ?? 10000)), null, 2))