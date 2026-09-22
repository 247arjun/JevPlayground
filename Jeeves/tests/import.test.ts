import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importDataset } from '../src/datasets/import.js'
import { Store } from '../src/storage/store.js'
import { fixture } from './fixtures.js'
import { hash } from '../src/security.js'

test('streams and verifies a dataset, snapshots config, and detects stale source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-import-'))
  try {
    const paths = await fixture(root)
    await symlink(paths.source, path.join(root, 'alias'))
    await assert.rejects(importDataset(paths.dataset, paths.source, path.join(root, 'alias/output')), /run_must_be_outside_inputs/)
    const result = await importDataset(paths.dataset, paths.source, paths.run)
    assert.equal(result.classificationCount, 1)
    assert.equal((await importDataset(paths.dataset, paths.source, paths.run)).status, 'already_imported')
    const store = await Store.open(paths.run)
    try {
      assert.equal((await store.query('SELECT COUNT(*) AS total FROM answers'))[0]?.total, 1)
      await store.set('importComplete', false)
    } finally { await store.close() }
    assert.equal((await importDataset(paths.dataset, paths.source, paths.run)).status, 'imported')
    assert.ok((await readFile(path.join(paths.run, 'snapshot/source/tsconfig.json'), 'utf8')).includes('strict'))
    await writeFile(path.join(paths.source, 'new.ts'), 'export const unseen = true')
    await assert.rejects(importDataset(paths.dataset, paths.source, paths.run), /source_inventory_changed/)
    await rm(path.join(paths.source, 'new.ts'))
    await writeFile(path.join(paths.source, 'code.ts'), 'changed')
    await assert.rejects(importDataset(paths.dataset, paths.source, paths.run), /source_hash_mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('snapshots unclassified source and documents without calling them classified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-additional-'))
  try {
    const paths = await fixture(root)
    await writeFile(path.join(paths.source, 'unclassified.ts'), 'export const helper = () => 1')
    await writeFile(path.join(paths.source, 'README.md'), 'Deployment context')
    const result = await importDataset(paths.dataset, paths.source, paths.run)
    assert.equal(result.additionalSourceFiles, 1)
    assert.equal(result.classificationCount, 1)
    assert.equal(await readFile(path.join(paths.run, 'snapshot/source/README.md'), 'utf8'), 'Deployment context')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a hash-consistent dataset that rewrites implementation as sanitization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-tamper-'))
  try {
    const paths = await fixture(root)
    const file = path.join(paths.dataset, 'functions.jsonl')
    const record = JSON.parse(await readFile(file, 'utf8'))
    record.sanitizedFunction = record.function.replace('return value', 'return false')
    record.sanitizedSourceHash = hash(record.sanitizedFunction)
    const content = JSON.stringify(record) + '\n'
    await writeFile(file, content)
    const manifestFile = path.join(paths.dataset, 'dataset.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.artifacts['functions.jsonl'] = { sha256: hash(content), bytes: Buffer.byteLength(content) }
    await writeFile(manifestFile, JSON.stringify(manifest))
    await assert.rejects(importDataset(paths.dataset, paths.source, paths.run), /sanitized_implementation_mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})