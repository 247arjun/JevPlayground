import { defaultLimits, classificationSchema, type FunctionRecord, type Limits } from '../domain.js'
import { errorCode } from '../security.js'
import { Store, getArtifact, putArtifact } from '../storage/store.js'
import { withRunLock } from '../storage/lock.js'
import { Navigation } from '../analysis/navigation.js'
import { Gateway } from '../tools/gateway.js'
import type { AgentBackend } from '../agents/runner.js'
import { claimTask, failTask, finishTask, recoverTasks } from './tasks.js'
import { reviewContract } from './contracts.js'

export async function runInvestigations (run: string, backend: AgentBackend, workers = 2, limits: Limits = defaultLimits, signal = new AbortController().signal): Promise<Record<string, unknown>> {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('invalid_worker_count')
  return await withRunLock(run, async () => {
    const store = await Store.open(run); const navigation = new Navigation(store, limits)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) controller.abort()
    let timer: NodeJS.Timeout | undefined
    let segmentStarted: number | undefined
    let previousElapsed = 0
    const usageWrites = new Set<Promise<void>>()
    const checkpointClock = async (closed = false) => {
      if (segmentStarted === undefined) return
      const now = Date.now()
      await store.batch([
        { sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)', params: ['runElapsedMs', JSON.stringify(previousElapsed + Math.max(0, now - segmentStarted))] },
        { sql: 'INSERT OR REPLACE INTO meta VALUES (?,?)', params: ['activeSegmentStarted', JSON.stringify(closed ? null : now)] }
      ])
    }
    try {
      if (!await store.get('planHash') || !await store.get('indexGeneration') || !await store.get('planComplete')) throw new Error('plan_not_ready')
      const identity = backend.identity ?? { provider: 'test', model: 'fake', promptVersion: 'test' }
      const previousIdentity = await store.get('agentIdentity')
      if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity)) throw new Error('different_agent_requires_new_run')
      await store.set('agentIdentity', identity)
      const previousLimits = await store.get('limits')
      if (JSON.stringify(previousLimits) !== JSON.stringify(limits)) await store.execute("INSERT INTO events(task_id,kind,data,time) VALUES (NULL,'run_limits_recorded',?,?)", [JSON.stringify({ previous: previousLimits ?? null, current: limits }), Date.now()])
      await store.set('limits', limits)
      await store.set('workers', workers)
      await recoverTasks(store)
      let blockReason: string | null = null
      previousElapsed = await store.get<number>('runElapsedMs') ?? 0
      const interrupted = await store.get<number>('activeSegmentStarted')
      if (interrupted) previousElapsed += Math.max(0, Date.now() - interrupted)
      segmentStarted = Date.now()
      await checkpointClock()
      let providerRequests = Number((await store.query('SELECT COUNT(*) AS count FROM provider_usage'))[0]!.count)
      const remaining = () => limits.maxRunDurationMs === null ? Number.POSITIVE_INFINITY : limits.maxRunDurationMs - previousElapsed - (Date.now() - segmentStarted!)
      const stop = (reason: string) => { blockReason ??= reason; controller.abort() }
      const armDeadline = () => {
        if (remaining() <= 0) stop('run_time_budget_exhausted')
        else if (Number.isFinite(remaining())) timer = setTimeout(armDeadline, Math.min(remaining(), 2147483647))
      }
      armDeadline()
      if (limits.maxRunProviderRequests !== null && providerRequests >= limits.maxRunProviderRequests) stop('run_provider_budget_exhausted')
      async function work (): Promise<void> {
        while (!controller.signal.aborted && !blockReason) {
          if (remaining() < 1000) { stop('run_time_budget_exhausted'); return }
          const attemptLimits = { ...limits, modelTimeoutMs: Math.min(limits.modelTimeoutMs, remaining()) }
          const task = await claimTask(store, attemptLimits.modelTimeoutMs + 30000, limits.maxModelCalls)
          if (!task) {
            if (limits.maxModelCalls !== null && Number(await store.get('modelCalls') ?? 0) >= limits.maxModelCalls && (await store.query("SELECT id FROM tasks WHERE state='queued' LIMIT 1")).length) blockReason ??= 'run_session_budget_exhausted'
            return
          }
          const gateway = new Gateway(store, navigation, task, attemptLimits)
          gateway.onProviderUsage = entry => {
            providerRequests++
            const saved = store.execute('INSERT OR IGNORE INTO provider_usage VALUES (?,?,?,?,?,?,?)', [entry.id, String(task.attempt), entry.model, entry.inputTokens, entry.outputTokens, entry.costMultiplier, Date.now()]).catch(() => { stop('usage_persistence_failed') }).finally(() => usageWrites.delete(saved))
            usageWrites.add(saved)
            if (limits.maxRunProviderRequests !== null && providerRequests >= limits.maxRunProviderRequests) stop('run_provider_budget_exhausted')
          }
          try {
            const row = task.function_id ? (await store.query('SELECT * FROM functions WHERE id=?', [String(task.function_id)]))[0] : undefined
            const fn = row ? await getArtifact<FunctionRecord>(run, String(row.artifact)) : null
            const subject = (await store.query('SELECT s.id,s.file,s.start,s.end,s.kind,s.purpose FROM review_subjects s JOIN candidates c ON c.subject_id=s.id WHERE c.id=?', [String(task.id)]))[0]
            const followUp = (await store.query("SELECT subject_id,operation,rationale FROM followups WHERE candidate_id=? AND state='approved' ORDER BY id LIMIT 1", [String(task.id)]))[0]
            if (!fn && !subject) throw new Error('review_subject_missing')
            const rawClassification = row?.classification_artifact ? classificationSchema.parse(await getArtifact(run, String(row.classification_artifact))) : null
            // Preserve raw imports for audit, but send only normalized answers.
            // Extra imported fields must not bypass the sanitized-source tools.
            const classification = rawClassification ? { model: rawClassification.model, answers: rawClassification.answers } : null
            const prior = task.result ? await getArtifact(run, String(task.result)) : null
            const context = { task: { id: task.id, attempt: task.attempt, role: task.role, theme: task.theme, codePurpose: task.purpose }, subject, followUp: followUp ? { originSubject: followUp.subject_id, operation: JSON.parse(String(followUp.operation)), rationale: followUp.rationale } : null, function: fn ? { id: fn.id, file: fn.file, start: fn.start, end: fn.end, name: fn.name } : null, classification, prior, reviewContract: reviewContract(String(task.theme)), instructions: 'Use read_source for cited code; do not assume classification labels establish related flows. A missing authorization signal is not a protection. Use inspect_context for non-function anchors and inspect_relationships to retrieve declared boundary evidence. Keep missing runtime, policy, and dependency evidence unresolved. Record cross-boundary flow with observed citations. Propose at most five distinct followUps with a listed subjectId and exact observed operation; proposals require operator review and do not authorize more work. Keep this a defensive source review: no payloads, exploitation instructions, target execution or network probing.' }
            const requestHash = await putArtifact(run, context)
            await store.execute('UPDATE attempts SET request_artifact=? WHERE id=?', [requestHash, String(task.attempt)])
            await backend.execute(task, context, gateway, controller.signal)
            if (!gateway.accepted) throw new Error('missing_structured_result')
            const result = { ...gateway.accepted, role: task.role, taskId: task.id, attempt: task.attempt, observedAt: new Date().toISOString(), usage: gateway.usage(), agent: identity, modelEvidenceNotRuntimeProof: true }
            const resultHash = await putArtifact(run, result)
            await finishTask(store, task, resultHash, gateway.accepted)
          } catch (error) {
            const code = errorCode(error)
            await failTask(store, task, code)
            if (controller.signal.aborted) {
              await store.execute("UPDATE tasks SET state='queued',attempt=NULL,error=? WHERE id=? AND state='failed'", [blockReason ?? 'cancelled', String(task.id)])
              await store.execute("UPDATE attempts SET state='paused' WHERE id=? AND state='failed'", [String(task.attempt)])
            }
            await store.execute("INSERT INTO events(task_id,kind,data,time) VALUES (?,'attempt_failed',?,?)", [String(task.id), JSON.stringify({ code, attempt: task.attempt, usage: gateway.usage() }), Date.now()])
            if (['provider_authentication_failed', 'provider_billing_blocked', 'provider_rate_limited', 'provider_unavailable'].includes(code)) blockReason = code
          } finally { gateway.close(); await checkpointClock() }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => work()))
      await store.set('blockReason', blockReason)
      return { tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state'), modelCalls: await store.get('modelCalls'), providerRequests, activeElapsedMs: previousElapsed + Date.now() - segmentStarted, compiler: navigation.workspaces.metrics, aborted: controller.signal.aborted, blockReason, maxModelCalls: limits.maxModelCalls }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel)
      await Promise.all(usageWrites)
      await checkpointClock(true)
      navigation.close(); await store.close()
    }
  })
}