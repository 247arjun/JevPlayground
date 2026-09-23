import { randomUUID } from 'node:crypto'
import type { AgentResult, Role, Row } from '../domain.js'
import { hash } from '../security.js'
import { Store, type Operation } from '../storage/store.js'

export const reviewRules: Array<{ name: string, any: string[], context?: string[] }> = [
  { name: 'outbound-destination', any: ['operation_outbound_communication'] },
  { name: 'query-structure', any: ['operation_database_query'] },
  { name: 'file-target', any: ['operation_file_or_object_access'] },
  { name: 'rendering-context', any: ['operation_content_rendering', 'operation_template_processing'] },
  { name: 'credential-output', any: ['output_sensitive_logging', 'output_sensitive_uri', 'output_sensitive_external_send'] },
  { name: 'credential-return', any: ['output_sensitive_return', 'output_sensitive_response'] },
  { name: 'authority-binding', any: ['operation_authorization_decision'] },
  { name: 'object-ownership', any: ['operation_data_store_access', 'operation_database_query', 'operation_file_or_object_access'], context: ['input_caller_supplied', 'input_external_request_event_or_user', 'influence_target_selection'] },
  { name: 'authentication-recovery', any: ['operation_identity_verification', 'operation_credential_handling'] },
  { name: 'cryptography', any: ['operation_cryptography'] },
  { name: 'security-values', any: ['operation_security_value_generation'] },
  { name: 'redirect-policy', any: ['operation_navigation_or_redirect'] },
  { name: 'parsing-validation', any: ['operation_data_parsing'] },
  { name: 'archive-policy', any: ['operation_archive_or_compression'] },
  { name: 'resource-limits', any: ['operation_input_scaled_work'] },
  { name: 'shared-state-invariant', any: ['operation_shared_state_check_and_act'] },
  { name: 'external-execution', any: ['operation_external_program_execution', 'operation_dynamic_code_interpretation'] },
  { name: 'sensitive-storage', any: ['output_sensitive_storage'] },
  { name: 'business-policy', any: ['context_intended_policy', 'influence_security_settings', 'influence_identity_or_authority'] },
  { name: 'response-disclosure', any: ['output_sensitive_response'] }
]

export const reviewThemes = new Set([...reviewRules.map(rule => rule.name), 'general-review', 'control-sample', 'endpoint-policy', 'configuration-policy', 'dependency-security'])

export interface PlanningOptions {
  mode?: 'full' | 'sample'
  maximum?: number
  seed?: string
  includeNonApplication?: boolean
}

export async function planTasks (store: Store, options: PlanningOptions | number = {}, legacySeed?: string): Promise<Record<string, unknown>> {
  const settings = typeof options === 'number' ? { mode: 'sample' as const, maximum: options, seed: legacySeed } : options
  const mode = settings.mode ?? 'full'
  const maximum = mode === 'sample' ? settings.maximum : undefined
  if (!['full', 'sample'].includes(mode) || (mode === 'sample' && (!Number.isSafeInteger(maximum) || maximum! < 1)) || (mode === 'full' && settings.maximum !== undefined)) throw new Error('invalid_operation_budget')
  const seed = settings.seed ?? 'jeeves-v2'
  if (!seed || seed.length > 200) throw new Error('invalid_plan_seed')
  const generation = await store.get<string>('indexGeneration')
  if (!generation) throw new Error('index_not_ready')
  const policyHash = hash(JSON.stringify({ version: 3, rules: reviewRules, mode, maximum, seed, generation, includeNonApplication: Boolean(settings.includeNonApplication) }))
  const previous = await store.get<string>('planHash')
  if (previous && previous !== policyHash) throw new Error('different_plan_requires_new_run')
  if (previous && await store.get('planComplete')) return { ...(await store.get<Record<string, unknown>>('plan')), policyHash }
  const planning = await store.get<string>('planningHash')
  if (planning && planning !== policyHash) throw new Error('different_plan_requires_new_run')
  if (!await store.get('planComplete') && (await store.query('SELECT id FROM attempts LIMIT 1')).length) throw new Error('cannot_replan_started_review')
  await store.set('planningHash', policyHash)
  await store.set('planComplete', false)
  await store.batch([{ sql: 'DELETE FROM tasks' }, { sql: 'DELETE FROM candidates' }])
  const snapshotId = await store.get<string>('snapshotId')
  for await (const row of store.scan('functions')) {
    await store.execute('INSERT OR IGNORE INTO review_subjects VALUES (?,?,?,?,?,?,?,?)', [String(row.id), String(row.id), String(row.file), Number(row.start), Number(row.end), 'function', String(row.purpose), '{}'])
    const answers = await store.query('SELECT question,choice FROM answers WHERE function_id=?', [String(row.id)])
    const signals = new Map(answers.map(answer => [String(answer.question), String(answer.choice)]))
    const relevant = (question: string) => ['present', 'unclear'].includes(signals.get(question) ?? '')
    const themes = reviewRules.filter(rule => rule.any.some(relevant) && (!rule.context || rule.context.some(relevant))).map(rule => rule.name)
    if (!themes.length) themes.push('general-review')
    const excluded = !settings.includeNonApplication && ['test_or_fixture', 'example_or_tooling', 'vendor'].includes(String(row.purpose))
    const priority = Math.max(0, 100 - (relevant('input_external_request_event_or_user') ? 35 : 0) - (relevant('influence_interpreted_structure') ? 20 : 0) - (relevant('influence_target_selection') ? 10 : 0) + (row.purpose === 'initialization' ? 25 : 0))
    await store.batch(themes.map(theme => ({ sql: 'INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?,?,?,?,NULL)', params: [hash(JSON.stringify([snapshotId, row.id, theme, policyHash])), String(row.id), theme, String(row.purpose), priority, hash(seed + String(row.id) + theme), excluded ? 'excluded' : 'deferred', JSON.stringify({ basis: answers.length ? 'classification_signals' : 'unclassified_fallback', purpose: row.purpose, relevant: [...signals].filter(([, choice]) => choice !== 'absent').map(([question]) => question), exclusion: excluded ? 'outside_declared_application_scope' : null })] })))
  }
  for await (const subject of store.scan('review_subjects')) {
    if (subject.function_id) continue
    const themes = subject.kind === 'template' ? ['rendering-context'] : subject.kind === 'dependency_manifest' ? ['dependency-security'] : ['route_declaration', 'generated_crud'].includes(String(subject.kind)) ? ['endpoint-policy', 'object-ownership', 'response-disclosure'] : subject.kind === 'configuration' ? ['configuration-policy'] : ['general-review']
    const excluded = !settings.includeNonApplication && ['test_or_fixture', 'example_or_tooling', 'vendor'].includes(String(subject.purpose))
    for (const theme of themes) await store.execute('INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?,?,?,?,NULL)', [hash(JSON.stringify([snapshotId, subject.id, theme, policyHash])), String(subject.id), theme, String(subject.purpose), subject.kind === 'route_declaration' ? 15 : subject.kind === 'template' ? 80 : 120, hash(seed + String(subject.id) + theme), excluded ? 'excluded' : subject.kind === 'unsupported_source' ? 'unsupported' : 'deferred', JSON.stringify({ basis: 'parsed_subject', kind: subject.kind, exclusion: excluded ? 'outside_declared_application_scope' : subject.kind === 'unsupported_source' ? 'context_parser_unavailable' : null })])
  }
  await store.execute(`UPDATE candidates SET priority=MAX(0,priority-20) WHERE subject_id IN (
    SELECT s.id FROM review_subjects s JOIN relationships r ON r.target=s.file
    WHERE r.kind='route_handler' AND s.kind IN ('function','unclassified_function'))`)

  await store.execute(`WITH ordered AS MATERIALIZED (
    SELECT c.id,c.priority,c.rank,
      ROW_NUMBER() OVER (PARTITION BY s.file ORDER BY c.priority,c.rank,c.id) AS file_rank,
      ROW_NUMBER() OVER (PARTITION BY c.theme ORDER BY c.priority,c.rank,c.id) AS theme_rank
    FROM candidates c JOIN review_subjects s ON s.id=c.subject_id WHERE c.decision='deferred')
    UPDATE candidates SET priority=ordered.priority+(ordered.file_rank-1)*20+(ordered.theme_rank-1)*4
    FROM ordered WHERE ordered.id=candidates.id`)

  if (mode === 'full') await store.execute("UPDATE candidates SET decision='selected' WHERE decision='deferred'")
  else {
    const controlCount = maximum! >= 5 ? Math.floor(maximum! * 0.2) : 0
    await store.execute(`UPDATE candidates SET decision='selected' WHERE id IN
      (SELECT id FROM candidates WHERE decision='deferred' ORDER BY priority,rank,id LIMIT ?)`, [maximum! - controlCount])
    const controls = await store.query(`SELECT s.id,s.purpose,MIN(c.rank) AS rank FROM review_subjects s JOIN candidates c ON c.subject_id=s.id
      WHERE c.decision='deferred' AND NOT EXISTS(SELECT 1 FROM candidates chosen WHERE chosen.subject_id=s.id AND chosen.decision='selected')
      GROUP BY s.id ORDER BY rank,s.id LIMIT ?`, [controlCount])
    for (const subject of controls) await store.execute('INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?,?,?,?,NULL)', [hash(JSON.stringify([snapshotId, subject.id, 'control-sample', policyHash])), String(subject.id), 'control-sample', String(subject.purpose), 150, String(subject.rank), 'selected', '{"basis":"reproducible_control"}'])
    const needed = maximum! - Number((await store.query("SELECT COUNT(*) AS count FROM candidates WHERE decision='selected'"))[0]!.count)
    if (needed > 0) await store.execute("UPDATE candidates SET decision='selected' WHERE id IN (SELECT id FROM candidates WHERE decision='deferred' ORDER BY priority,rank,id LIMIT ?)", [needed])
  }
  await store.execute(`INSERT OR IGNORE INTO tasks (id,function_id,theme,purpose,state,role,priority)
    SELECT c.id,s.function_id,c.theme,c.purpose,'queued','localizer',c.priority
    FROM candidates c JOIN review_subjects s ON s.id=c.subject_id WHERE c.decision='selected'`)
  const decisions = await store.query('SELECT decision,COUNT(*) AS count FROM candidates GROUP BY decision')
  const planned = Number((await store.query('SELECT COUNT(*) AS count FROM tasks'))[0]!.count)
  const catalogue = Number((await store.query('SELECT COUNT(*) AS count FROM candidates'))[0]!.count)
  const controlCount = Number((await store.query("SELECT COUNT(*) AS count FROM tasks WHERE theme='control-sample'"))[0]!.count)
  const summary = { mode, maximum: maximum ?? null, seed, rules: reviewRules, planned, candidateCount: catalogue, decisions, scope: settings.includeNonApplication ? 'all_source' : 'application', controlCount }
  await store.set('planHash', policyHash)
  await store.set('plan', summary)
  await store.set('planComplete', true)
  return { ...summary, policyHash }
}

export async function claimTask (store: Store, timeoutMs: number, maximumCalls: number | null): Promise<Row | undefined> {
  const attempt = randomUUID(); const now = Date.now()
  const result = await store.batch([
    { sql: `UPDATE tasks SET state='running',attempt=?,deadline=? WHERE id=(SELECT id FROM tasks WHERE state='queued' ORDER BY priority,id LIMIT 1)
      AND (? IS NULL OR COALESCE(CAST((SELECT value FROM meta WHERE key='modelCalls') AS INTEGER),0) < ?) RETURNING *`, params: [attempt, now + timeoutMs, maximumCalls, maximumCalls], mode: 'all' },
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
  const parent = (await store.query('SELECT MAX(depth) AS depth FROM followups WHERE candidate_id=?', [String(task.id)]))[0]
  const depth = Number(parent?.depth ?? 0) + 1
  const snapshotId = await store.get('snapshotId')
  const operations: Operation[] = [
    { sql: "UPDATE tasks SET state=?,role=?,result=?,error=NULL,deadline=NULL WHERE id=? AND attempt=? AND state='running' RETURNING id", params: [terminal ? 'completed' : 'queued', terminal ? role : next, resultHash, String(task.id), String(task.attempt)], mode: 'all' },
    { sql: "UPDATE attempts SET state='completed',finished=?,result_artifact=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND attempt=? AND result=?)", params: [Date.now(), resultHash, String(task.attempt), String(task.id), String(task.attempt), resultHash] },
    { sql: "INSERT INTO events(task_id,kind,data,time) SELECT id,'result_accepted',?,? FROM tasks WHERE id=? AND attempt=? AND result=?", params: [JSON.stringify({ role, resultHash, disposition: result.disposition }), Date.now(), String(task.id), String(task.attempt), resultHash] },
    { sql: 'INSERT OR REPLACE INTO task_results SELECT id,?,?,? FROM tasks WHERE id=? AND attempt=? AND result=?', params: [result.disposition, result.operation ? hash(JSON.stringify([result.operation, task.theme])) : null, resultHash, String(task.id), String(task.attempt), resultHash] }
  ]
  for (const proposal of result.followUps ?? []) {
    if (!reviewThemes.has(proposal.theme)) continue
    const id = hash(JSON.stringify([snapshotId, proposal.subjectId, proposal.theme, proposal.operation]))
    operations.push({ sql: 'INSERT OR IGNORE INTO followups SELECT ?,id,?,?,?,?,?,?,NULL FROM tasks WHERE id=? AND attempt=? AND result=?', params: [id, proposal.subjectId, proposal.theme, JSON.stringify(proposal.operation), proposal.rationale, depth, depth > 3 ? 'depth_limited' : 'proposed', String(task.id), String(task.attempt), resultHash] })
  }
  const values = await store.batch(operations)
  if (!(values[0] as Row[]).length) throw new Error('stale_attempt')
}

export async function approveFollowups (store: Store, ids: string[]): Promise<Record<string, unknown>> {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('invalid_followup_selection')
  const snapshot = await store.get('snapshotId'); const policy = await store.get('planHash')
  if (!policy || !await store.get('planComplete')) throw new Error('plan_not_ready')
  let admitted = 0
  for (const id of ids) {
    const row = (await store.query('SELECT p.*,s.function_id,s.purpose FROM followups p JOIN review_subjects s ON s.id=p.subject_id WHERE p.id=?', [id]))[0]
    if (!row || row.state !== 'proposed' || Number(row.depth) > 3 || !reviewThemes.has(String(row.theme))) throw new Error('followup_not_approvable')
  }
  for (const id of ids) {
    const row = (await store.query('SELECT p.*,s.function_id,s.purpose,s.file,s.start,s.end FROM followups p JOIN review_subjects s ON s.id=p.subject_id WHERE p.id=?', [id]))[0]!
    const operation = JSON.parse(String(row.operation)) as { file: string, start: number, end: number, sourceHash: string }
    const subject = hash(JSON.stringify([snapshot, row.subject_id, operation]))
    const existing = (await store.query(`SELECT c.id FROM candidates c JOIN review_subjects s ON s.id=c.subject_id LEFT JOIN task_results r ON r.task_id=c.id
      WHERE c.theme=? AND (s.id=? OR (s.id=? AND (r.operation_key=? OR (s.start=? AND s.end=?)))) LIMIT 1`, [String(row.theme), subject, String(row.subject_id), hash(JSON.stringify([operation, row.theme])), operation.start, operation.end]))[0]
    const candidate = existing ? String(existing.id) : hash(JSON.stringify([snapshot, subject, row.theme, policy]))
    await store.batch([
      { sql: 'INSERT OR IGNORE INTO review_subjects VALUES (?,NULL,?,?,?,?,?,?)', params: [subject, operation.file, operation.start, operation.end, 'followup_operation', String(row.purpose), JSON.stringify({ originSubject: row.subject_id, parentTask: row.task_id, rationale: row.rationale })] },
      { sql: 'INSERT OR IGNORE INTO candidates VALUES (?,?,?,?,?,?,?,?,NULL)', params: [candidate, subject, String(row.theme), String(row.purpose), 80, hash(candidate), 'selected', JSON.stringify({ basis: 'operator_approved_followup', parentTask: row.task_id, originSubject: row.subject_id, operation })] },
      { sql: "UPDATE candidates SET decision='selected' WHERE id=?", params: [candidate] },
      { sql: `INSERT OR IGNORE INTO tasks (id,function_id,theme,purpose,state,role,priority)
          SELECT c.id,s.function_id,c.theme,c.purpose,'queued','localizer',80 FROM candidates c JOIN review_subjects s ON s.id=c.subject_id WHERE c.id=?`, params: [candidate] },
      { sql: "UPDATE followups SET state='approved',candidate_id=? WHERE id=? AND state='proposed'", params: [candidate, id] },
      { sql: "INSERT INTO events(task_id,kind,data,time) VALUES (?,'followup_approved',?,?)", params: [candidate, JSON.stringify({ proposalId: id, parentTask: row.task_id }), Date.now()] }
    ])
    admitted++
  }
  return { approved: admitted, note: 'Shared run budgets are unchanged; an existing matching task is not rerun.' }
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

export async function continueInconclusive (store: Store): Promise<void> {
  await store.execute(`UPDATE tasks SET state='queued',attempt=NULL,error=NULL,role=CASE WHEN role='challenger' THEN 'investigator' ELSE role END
    WHERE state='completed' AND id IN (SELECT task_id FROM task_results WHERE disposition IN ('needs_context','budget_exhausted'))
    AND (SELECT COUNT(*) FROM attempts WHERE attempts.task_id=tasks.id AND attempts.role=CASE WHEN tasks.role='challenger' THEN 'investigator' ELSE tasks.role END)<3`)
}