import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importDataset } from '../src/datasets/import.js'
import { Store } from '../src/storage/store.js'
import { fixture } from './fixtures.js'

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
    await writeFile(path.join(paths.source, 'code.ts'), 'changed')
    await assert.rejects(importDataset(paths.dataset, paths.source, paths.run), /source_hash_mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})