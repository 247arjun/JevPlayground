import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store } from '../src/storage/store.js'
import { claimTask, finishTask, planTasks, recoverTasks } from '../src/orchestration/tasks.js'
import type { AgentResult } from '../src/domain.js'

test('task claims are unique, budgeted, fenced and recoverable after expiry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-tasks-')); const store = await Store.open(root)
  try {
    await store.execute("INSERT INTO files VALUES ('code.ts','hash',1,'tsjs')")
    await store.execute("INSERT INTO functions VALUES ('function','code.ts','lookup','Function',0,1,NULL,'hash','hash','artifact',NULL,'application_candidate')")
    await store.execute("INSERT INTO answers VALUES ('function','operation_external_program_execution','present',1,'{}')")
    await store.set('snapshotId', 'snapshot'); await store.set('indexGeneration', 'generation')
    assert.equal((await planTasks(store, 1)).planned, 1)
    const claims = await Promise.all([claimTask(store, 10000, 10), claimTask(store, 10000, 10)])
    assert.equal(claims.filter(Boolean).length, 1)
    const first = claims.find(Boolean)!
    await store.execute('UPDATE tasks SET deadline=0 WHERE id=?', [String(first.id)])
    assert.equal(await recoverTasks(store), 1)
    const second = (await claimTask(store, 10000, 10))!
    const result: AgentResult = { disposition: 'needs_context', summary: 'Caller unknown', operation: null, invariant: '', facts: [], assumptions: [], counterevidence: [], unresolved: ['Caller'] }
    await assert.rejects(finishTask(store, first, 'old', result), /stale_attempt/)
    await finishTask(store, second, 'new', result)
    assert.equal((await store.query('SELECT role FROM tasks'))[0]?.role, 'investigator')
    assert.equal(await claimTask(store, 10000, 2), undefined)
    assert.equal(await store.get('modelCalls'), 2)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})