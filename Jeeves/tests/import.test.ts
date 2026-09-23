import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importDataset } from '../src/datasets/import.js'
import { Store } from '../src/storage/store.js'
import { fixture } from './fixtures.js'
import { hash } from '../src/security.js'
import { pathPurpose } from '../src/analysis/purpose.js'

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

test('snapshots template and configuration evidence with explicit private-file and purpose boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-context-'))
  try {
    const paths = await fixture(root)
    await mkdir(path.join(paths.source, 'fixtures'))
    await writeFile(path.join(paths.source, 'view.html'), '<p>{{ message }}</p>')
    await writeFile(path.join(paths.source, 'settings.yml'), 'limits:\n  attempts: 3\n')
    await writeFile(path.join(paths.source, '.env'), 'SAMPLE=not-for-models')
    await writeFile(path.join(paths.source, 'secrets.json'), '{"sample":"not-for-models"}')
    await writeFile(path.join(paths.source, 'fixtures/example.ts'), 'export const sample = 1')
    await writeFile(path.join(paths.source, 'tsconfig.json'), JSON.stringify({ exclude: ['fixtures/**'], include: ['*.ts'] }))
    await importDataset(paths.dataset, paths.source, paths.run)
    const store = await Store.open(paths.run)
    try {
      assert.equal((await store.query('SELECT language FROM files WHERE path=?', ['view.html']))[0]?.language, 'template')
      assert.equal((await store.query('SELECT language FROM files WHERE path=?', ['settings.yml']))[0]?.language, 'configuration')
      assert.equal((await store.query('SELECT path FROM files WHERE path IN (?,?)', ['.env', 'secrets.json'])).length, 0)
      assert.equal((await store.query('SELECT COUNT(*) AS count FROM snapshot_omissions WHERE reason=?', ['private_file_policy']))[0]?.count, 2)
      const context = JSON.parse(String((await store.query('SELECT data FROM file_context WHERE file=?', ['fixtures/example.ts']))[0]!.data))
      assert.deepEqual(context.excludedBy, ['tsconfig.json'])
      assert.equal(context.purpose, 'test_or_fixture')
      assert.equal(pathPurpose('data/static/codefixes/example.ts').purpose, 'test_or_fixture')
      assert.equal(pathPurpose('cypress.config.ts').purpose, 'example_or_tooling')
      assert.equal(pathPurpose('src/handler.ts').purpose, 'application_candidate')
    } finally { await store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})