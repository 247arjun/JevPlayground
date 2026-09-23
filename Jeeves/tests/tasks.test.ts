import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store } from '../src/storage/store.js'
import { approveFollowups, claimTask, finishTask, planTasks, recoverTasks } from '../src/orchestration/tasks.js'
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

test('full planning inventories every function and does not discard additional review themes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-full-plan-')); const store = await Store.open(root)
  try {
    await store.execute("INSERT INTO files VALUES ('code.ts','hash',10000,'tsjs')")
    for (let index = 0; index < 1200; index++) {
      const id = `function-${String(index).padStart(3, '0')}`
      await store.execute('INSERT INTO functions (id,file,name,kind,start,end,source_hash,sanitized_hash,artifact,purpose) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, 'code.ts', 'handler', 'Function', index * 10, index * 10 + 9, 'hash', 'hash', 'artifact', 'application_candidate'])
      await store.execute('INSERT INTO answers VALUES (?,?,?,?,?)', [id, 'operation_database_query', 'present', 1, '{}'])
      await store.execute('INSERT INTO answers VALUES (?,?,?,?,?)', [id, 'influence_interpreted_structure', 'present', 1, '{}'])
      await store.execute('INSERT INTO answers VALUES (?,?,?,?,?)', [id, 'operation_cryptography', 'present', 1, '{}'])
    }
    await store.set('snapshotId', 'snapshot'); await store.set('indexGeneration', 'generation')
    const plan = await planTasks(store)
    assert.equal(plan.mode, 'full')
    assert.equal((await store.query('SELECT COUNT(DISTINCT function_id) AS count FROM tasks'))[0]?.count, 1200)
    assert.equal((await store.query('SELECT COUNT(*) AS count FROM tasks WHERE theme=?', ['query-structure']))[0]?.count, 1200)
    assert.equal((await store.query('SELECT COUNT(*) AS count FROM tasks WHERE theme=?', ['cryptography']))[0]?.count, 1200)
    const repeated = await planTasks(store)
    assert.equal(repeated.planned, plan.planned)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('follow-up work remains proposed until approved and never resets the run budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-followups-')); const store = await Store.open(root)
  try {
    await store.execute("INSERT INTO files VALUES ('code.ts','hash',100,'tsjs')")
    await store.execute("INSERT INTO functions VALUES ('function','code.ts','lookup','Function',0,100,NULL,'hash','hash','artifact',NULL,'application_candidate')")
    await store.set('snapshotId', 'snapshot'); await store.set('indexGeneration', 'generation')
    await planTasks(store, 1)
    const task = (await claimTask(store, 10000, 10))!
    const result: AgentResult = { disposition: 'refuted_hypothesis', summary: 'Assigned question refuted; separate issue needs review.', operation: null, invariant: '', facts: [], assumptions: [], counterevidence: [], unresolved: [], followUps: [{ subjectId: 'function', theme: 'cryptography', operation: { file: 'code.ts', start: 0, end: 100, sourceHash: '0'.repeat(64) }, rationale: 'Separate primitive-purpose review.' }] }
    await assert.rejects(finishTask(store, { ...task, attempt: 'stale' }, 'ignored', result), /stale_attempt/)
    assert.equal((await store.query('SELECT COUNT(*) AS count FROM followups'))[0]?.count, 0)
    await finishTask(store, task, 'result', result)
    const proposal = (await store.query('SELECT * FROM followups'))[0]!
    assert.equal(proposal.state, 'proposed')
    assert.equal((await store.query("SELECT COUNT(*) AS count FROM tasks WHERE state='queued'"))[0]?.count, 0)
    await approveFollowups(store, [String(proposal.id)])
    assert.equal((await store.query("SELECT COUNT(*) AS count FROM tasks WHERE state='queued'"))[0]?.count, 1)
    assert.equal(await store.get('modelCalls'), 1)
    await assert.rejects(approveFollowups(store, [String(proposal.id)]), /followup_not_approvable/)
    const secondTask = (await claimTask(store, 10000, 10))!
    const secondResult: AgentResult = { ...result, operation: { file: 'code.ts', start: 0, end: 20, sourceHash: '0'.repeat(64) }, followUps: [{ subjectId: 'function', theme: 'cryptography', operation: { file: 'code.ts', start: 40, end: 60, sourceHash: '0'.repeat(64) }, rationale: 'Different operation in the same function and theme.' }] }
    await finishTask(store, secondTask, 'second-result', secondResult)
    const distinctProposal = (await store.query("SELECT id FROM followups WHERE state='proposed'"))[0]!
    await approveFollowups(store, [String(distinctProposal.id)])
    const distinct = (await store.query("SELECT t.id,s.start,s.end FROM tasks t JOIN candidates c ON c.id=t.id JOIN review_subjects s ON s.id=c.subject_id WHERE t.state='queued'"))[0]!
    assert.notEqual(distinct.id, secondTask.id)
    assert.equal(distinct.start, 40)
    assert.equal(distinct.end, 60)
    assert.equal(await store.get('modelCalls'), 2)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test('interrupted sample planning replays exactly and file diversity changes order rather than discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-replay-plan-')); const store = await Store.open(root)
  try {
    for (const file of ['first.ts', 'last.ts']) {
      await store.execute('INSERT INTO files VALUES (?,?,?,?)', [file, 'hash', 1000, 'tsjs'])
      for (let index = 0; index < 15; index++) {
        const id = `${file}:${index}`
        await store.execute('INSERT INTO functions (id,file,name,kind,start,end,source_hash,sanitized_hash,artifact,purpose) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, file, 'lookup', 'Function', index * 10, index * 10 + 9, 'hash', 'hash', 'artifact', 'application_candidate'])
        await store.execute('INSERT INTO answers VALUES (?,?,?,?,?)', [id, 'operation_database_query', 'present', 1, '{}'])
        await store.execute('INSERT INTO answers VALUES (?,?,?,?,?)', [id, 'input_external_request_event_or_user', 'present', 1, '{}'])
      }
    }
    await store.set('snapshotId', 'snapshot'); await store.set('indexGeneration', 'generation')
    await planTasks(store, { mode: 'sample', maximum: 10 })
    const original = await store.query('SELECT * FROM candidates ORDER BY id')
    const selected = await store.query('SELECT * FROM tasks ORDER BY id')
    assert.equal(selected.length, 10)
    assert.equal(new Set((await store.query('SELECT s.file FROM tasks t JOIN candidates c ON c.id=t.id JOIN review_subjects s ON s.id=c.subject_id')).map(row => row.file)).size, 2)
    assert.ok(original.length > 30)
    await store.set('planComplete', false)
    await planTasks(store, { mode: 'sample', maximum: 10 })
    assert.deepEqual(await store.query('SELECT * FROM candidates ORDER BY id'), original)
    assert.deepEqual(await store.query('SELECT * FROM tasks ORDER BY id'), selected)
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})