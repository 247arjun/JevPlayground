import { randomUUID } from 'node:crypto'
import type { AgentResult, Role, Row } from '../domain.js'
import { hash } from '../security.js'
import { Store } from '../storage/store.js'

const rules: Array<{ name: string, operation: string, influence?: string }> = [
  { name: 'outbound-destination', operation: 'operation_outbound_communication', influence: 'influence_target_selection' },
  { name: 'query-structure', operation: 'operation_database_query', influence: 'influence_interpreted_structure' },
  { name: 'file-target', operation: 'operation_file_or_object_access', influence: 'influence_target_selection' },
  { name: 'rendering-context', operation: 'operation_content_rendering', influence: 'influence_interpreted_structure' },
  { name: 'credential-output', operation: 'operation_credential_handling', influence: 'output_sensitive_logging' },
  { name: 'credential-return', operation: 'operation_credential_handling', influence: 'output_sensitive_return' },
  { name: 'authority-binding', operation: 'operation_authorization_decision', influence: 'influence_identity_or_authority' },
  { name: 'shared-state-invariant', operation: 'operation_shared_state_check_and_act' },
  { name: 'external-execution', operation: 'operation_external_program_execution' }
]

export async function planTasks (store: Store, maximum = 25, seed = 'jeeves-v1'): Promise<Record<string, unknown>> {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 200) throw new Error('invalid_operation_budget')
  const generation = await store.get<string>('indexGeneration')
  if (!generation) throw new Error('index_not_ready')
  const policyHash = hash(JSON.stringify({ rules, maximum, seed, generation }))
  const previous = await store.get<string>('planHash')
  if (previous && previous !== policyHash) throw new Error('different_plan_requires_new_run')
  const snapshotId = await store.get<string>('snapshotId')
  const candidates = new Map<string, { functionId: string, theme: string, purpose: string, priority: number }>()
  const controlCount = maximum >= 5 ? Math.max(1, Math.floor(maximum * 0.2)) : 0
  const ruleCandidates: Row[][] = []
  for (const rule of rules) {
    ruleCandidates.push(await store.query(`SELECT f.id,f.purpose FROM functions f JOIN answers operation ON operation.function_id=f.id
      WHERE f.purpose='application_candidate' AND operation.question=? AND operation.choice='present'
      ${rule.influence ? "AND EXISTS (SELECT 1 FROM answers influence WHERE influence.function_id=f.id AND influence.question=? AND influence.choice='present')" : ''}
      ORDER BY f.id LIMIT ?`, rule.influence ? [rule.operation, rule.influence, maximum] : [rule.operation, maximum]))
  }
  // Round-robin themes so a large class of operations cannot consume every slot.
  for (let rank = 0; rank < maximum && candidates.size < maximum - controlCount; rank++) {
    for (let index = 0; index < rules.length && candidates.size < maximum - controlCount; index++) {
      const row = ruleCandidates[index]?.[rank]
      if (!row || candidates.has(String(row.id))) continue
      candidates.set(String(row.id), { functionId: String(row.id), theme: rules[index]!.name, purpose: String(row.purpose), priority: 1 })
    }
  }
  const controls: Array<{ rank: string, row: Row }> = []
  for await (const row of store.scan('functions')) {
    if (candidates.has(String(row.id))) continue
    controls.push({ rank: hash(seed + String(row.id)), row })
    controls.sort((first, second) => first.rank.localeCompare(second.rank))
    if (controls.length > Math.max(controlCount, maximum - candidates.size)) controls.pop()
  }
  for (const { row } of controls.slice(0, maximum - candidates.size)) candidates.set(String(row.id), { functionId: String(row.id), theme: 'control-sample', purpose: String(row.purpose), priority: 2 })
  for (const candidate of candidates.values()) {
    const id = hash(JSON.stringify([snapshotId, candidate.functionId, candidate.theme, policyHash]))
    await store.execute("INSERT OR IGNORE INTO tasks VALUES (?,?,?,?, 'queued','localizer',NULL,NULL,NULL,NULL,?)", [id, candidate.functionId, candidate.theme, candidate.purpose, candidate.priority])
  }
  await store.set('planHash', policyHash)
  await store.set('plan', { maximum, seed, rules, candidateCount: candidates.size, controlCount: [...candidates.values()].filter(value => value.theme === 'control-sample').length })
  return { planned: candidates.size, policyHash, seed }
}

export async function claimTask (store: Store, timeoutMs: number, maximumCalls: number): Promise<Row | undefined> {
  const attempt = randomUUID(); const now = Date.now()
  const result = await store.batch([
    { sql: `UPDATE tasks SET state='running',attempt=?,deadline=? WHERE id=(SELECT id FROM tasks WHERE state='queued' ORDER BY priority,id LIMIT 1)
      AND COALESCE(CAST((SELECT value FROM meta WHERE key='modelCalls') AS INTEGER),0) < ? RETURNING *`, params: [attempt, now + timeoutMs, maximumCalls], mode: 'all' },
    { sql: "INSERT INTO attempts SELECT ?,id,role,?,NULL,'running',NULL,NULL FROM tasks WHERE attempt=?", params: [attempt, now, attempt] },
    { sql: "INSERT INTO meta SELECT 'modelCalls','1' WHERE EXISTS(SELECT 1 FROM tasks WHERE attempt=?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)", params: [attempt] },
    { sql: "INSERT INTO events(task_id,kind,data,time) SELECT id,'claimed',?,? FROM tasks WHERE attempt=?", params: [JSON.stringify({ attempt }), now, attempt] }
  ])
  return (result[0] as Row[])[0]
}

export async function finishTask (store: Store, task: Row, resultHash: string, result: AgentResult): Promise<void> {
  const role = task.role as Role
  const next = role === 'localizer' ? 'investigator' : 'challenger'
  const terminal = role === 'challenger' || ['no_relevant_operation', 'refuted_hypothesis', 'budget_exhausted'].includes(result.disposition)
  const values = await store.batch([
    { sql: "UPDATE tasks SET state=?,role=?,result=?,error=NULL,deadline=NULL WHERE id=? AND attempt=? AND state='running' RETURNING id", params: [terminal ? 'completed' : 'queued', terminal ? role : next, resultHash, String(task.id), String(task.attempt)], mode: 'all' },
    { sql: "UPDATE attempts SET state='completed',finished=?,result_artifact=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt=? AND result=?)", params: [Date.now(), resultHash, String(task.attempt), String(task.id), String(task.attempt), resultHash] },
    { sql: "INSERT INTO events(task_id,kind,data,time) SELECT id,'result_accepted',?,? FROM tasks WHERE id=? AND attempt=? AND result=?", params: [JSON.stringify({ role, resultHash, disposition: result.disposition }), Date.now(), String(task.id), String(task.attempt), resultHash] }
  ])
  if (!(values[0] as Row[]).length) throw new Error('stale_attempt')
}

export async function failTask (store: Store, task: Row, code: string): Promise<void> {
  await store.batch([
    { sql: "UPDATE tasks SET state='failed',error=?,deadline=NULL WHERE id=? AND attempt=? AND state='running'", params: [code, String(task.id), String(task.attempt)] },
    { sql: "UPDATE attempts SET state='failed',finished=? WHERE id=? AND state='running'", params: [Date.now(), String(task.attempt)] }
  ])
}

export async function recoverTasks (store: Store): Promise<number> {
  const result = await store.batch([
    { sql: "UPDATE attempts SET state='completion_unknown',finished=? WHERE state='running' AND id IN (SELECT attempt FROM tasks WHERE state='running' AND deadline<?)", params: [Date.now(), Date.now()] },
    { sql: "UPDATE tasks SET state='queued',attempt=NULL,deadline=NULL,error='expired_attempt' WHERE state='running' AND deadline<? RETURNING id", params: [Date.now()], mode: 'all' }
  ])
  return (result[1] as Row[]).length
}

export async function retryFailedTasks (store: Store): Promise<void> {
  await store.execute("UPDATE tasks SET state='queued',attempt=NULL,error=NULL WHERE state='failed' AND (SELECT COUNT(*) FROM attempts WHERE attempts.task_id=tasks.id AND attempts.role=tasks.role) < 3")
}