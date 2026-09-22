import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fixture } from './fixtures.js'
import { importDataset } from '../src/datasets/import.js'
import { buildIndex, callPage } from '../src/analysis/index.js'
import { Store } from '../src/storage/store.js'
import { hash } from '../src/security.js'

test('new snapshots reuse only unchanged syntax and invalidate semantic caches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-incremental-'))
  try {
    await mkdir(path.join(root, 'first')); await mkdir(path.join(root, 'second'))
    const first = await fixture(path.join(root, 'first')); const second = await fixture(path.join(root, 'second'))
    const helper = 'export function caller() { return lookup("value") }'
    await writeFile(path.join(first.source, 'caller.ts'), helper)
    await writeFile(path.join(second.source, 'caller.ts'), helper)
    await importDataset(first.dataset, first.source, first.run)
    const initial = await buildIndex(first.run)
    const file = path.join(second.source, 'code.ts')
    const original = await readFile(file, 'utf8')
    const changed = original.replace('return value', 'return "new"')
    await writeFile(file, changed)
    const records = JSON.parse((await readFile(path.join(second.dataset, 'functions.jsonl'), 'utf8')).trim())
    records.function = changed; records.sanitizedFunction = changed; records.sourceHash = hash(changed); records.sanitizedSourceHash = hash(changed)
    await writeFile(path.join(second.dataset, 'functions.jsonl'), JSON.stringify(records) + '\n')
    const classifications = JSON.parse(await readFile(path.join(second.dataset, 'classifications.json'), 'utf8'))
    classifications[0] = { ...classifications[0], ...records }
    await writeFile(path.join(second.dataset, 'classifications.json'), JSON.stringify(classifications))
    await writeFile(path.join(second.dataset, 'inventory.json'), JSON.stringify({ files: [{ file: 'code.ts', sourceHash: hash(changed) }], skipped: [] }))
    const manifest = JSON.parse(await readFile(path.join(second.dataset, 'dataset.json'), 'utf8'))
    for (const name of Object.keys(manifest.artifacts)) {
      const content = await readFile(path.join(second.dataset, name))
      manifest.artifacts[name] = { sha256: hash(content), bytes: content.length }
    }
    await writeFile(path.join(second.dataset, 'dataset.json'), JSON.stringify(manifest))
    await importDataset(second.dataset, second.source, second.run)
    const refreshed = await buildIndex(second.run, first.run)
    assert.equal(refreshed.reusedFromPrevious, 1)
    assert.equal(refreshed.parsedFiles, 1)
    assert.notEqual(refreshed.generation, initial.generation)
    const store = await Store.open(second.run)
    try {
      assert.equal((await callPage(store, 'lookup')).rows instanceof Array, true)
      assert.equal((await store.query('SELECT COUNT(*) AS count FROM semantic_results'))[0]?.count, 0)
      assert.equal((await store.query('SELECT COUNT(*) AS count FROM calls WHERE name=?', ['lookup']))[0]?.count, 1)
    } finally { await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})