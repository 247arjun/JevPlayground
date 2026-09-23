import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store, getArtifact, putArtifact } from '../src/storage/store.js'
import { DatabaseSync } from 'node:sqlite'
import { hash } from '../src/security.js'

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

test('read-only stores preserve the database and v1 migration retains task history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-migration-'))
  const file = path.join(root, 'state.sqlite')
  try {
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, function_id TEXT NOT NULL, theme TEXT NOT NULL, purpose TEXT NOT NULL, state TEXT NOT NULL, role TEXT NOT NULL, attempt TEXT, deadline INTEGER, result TEXT, error TEXT, priority INTEGER NOT NULL);
      INSERT INTO tasks VALUES ('old','function','general-review','application_candidate','completed','localizer',NULL,NULL,'artifact',NULL,1);
      PRAGMA user_version=1;`)
    old.close()
    const before = hash(await readFile(file))
    const readonly = await Store.open(root, true)
    try {
      assert.equal((await readonly.query('SELECT state FROM tasks'))[0]?.state, 'completed')
      await assert.rejects(readonly.execute('DELETE FROM tasks'), /database_operation_failed/)
    } finally { await readonly.close() }
    assert.equal(hash(await readFile(file)), before)
    const migrated = await Store.open(root)
    try {
      assert.equal((await migrated.query('PRAGMA user_version'))[0]?.user_version, 2)
      assert.equal((await migrated.query('SELECT result FROM tasks WHERE id=?', ['old']))[0]?.result, 'artifact')
      await migrated.execute("INSERT INTO tasks VALUES ('template',NULL,'rendering-context','application_candidate','queued','localizer',NULL,NULL,NULL,NULL,1)")
    } finally { await migrated.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})