import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store, getArtifact, putArtifact } from '../src/storage/store.js'

test('SQLite worker persists transactions, rolls back failures and bounds batches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-db-'))
  let store = await Store.open(root)
  try {
    await store.set('run', { revision: 'test' })
    await assert.rejects(store.batch([
      { sql: 'INSERT INTO meta VALUES (?,?)', params: ['temporary', 'true'] },
      { sql: 'INSERT INTO meta VALUES (?,?)', params: ['run', 'false'] }
    ]), /database_operation_failed/)
    assert.equal(await store.get('temporary'), undefined)
    await assert.rejects(store.batch(Array.from({ length: 501 }, () => ({ sql: 'SELECT 1' }))), /backpressure/)
    const artifact = await putArtifact(root, { evidence: 'literal' })
    assert.deepEqual(await getArtifact(root, artifact), { evidence: 'literal' })
    await store.close()
    store = await Store.open(root)
    assert.deepEqual(await store.get('run'), { revision: 'test' })
    const rows = await store.query('PRAGMA journal_mode')
    assert.equal(rows[0]?.journal_mode, 'wal')
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})