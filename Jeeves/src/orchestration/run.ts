import { defaultLimits, classificationSchema, type FunctionRecord, type Limits } from '../domain.js'
import { errorCode } from '../security.js'
import { Store, getArtifact, putArtifact } from '../storage/store.js'
import { withRunLock } from '../storage/lock.js'
import { Navigation } from '../analysis/navigation.js'
import { Gateway } from '../tools/gateway.js'
import type { AgentBackend } from '../agents/runner.js'
import { claimTask, failTask, finishTask, recoverTasks } from './tasks.js'

export async function runInvestigations (run: string, backend: AgentBackend, workers = 2, limits: Limits = defaultLimits, signal = new AbortController().signal): Promise<Record<string, unknown>> {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('invalid_worker_count')
  return await withRunLock(run, async () => {
    const store = await Store.open(run); const navigation = new Navigation(store, limits)
    try {
      if (!await store.get('planHash') || !await store.get('indexGeneration')) throw new Error('plan_not_ready')
      const identity = backend.identity ?? { provider: 'test', model: 'fake', promptVersion: 'test' }
      const previousIdentity = await store.get('agentIdentity')
      if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity)) throw new Error('different_agent_requires_new_run')
      await store.set('agentIdentity', identity)
      await store.set('limits', limits)
      await recoverTasks(store)
      let blockReason: string | null = null
      async function work (): Promise<void> {
        while (!signal.aborted && !blockReason) {
          const task = await claimTask(store, limits.modelTimeoutMs + 30000, limits.maxModelCalls)
          if (!task) return
          const gateway = new Gateway(store, navigation, task, limits)
          try {
            const row = (await store.query('SELECT * FROM functions WHERE id=?', [String(task.function_id)]))[0]!
            const fn = await getArtifact<FunctionRecord>(run, String(row.artifact))
            const rawClassification = row.classification_artifact ? classificationSchema.parse(await getArtifact(run, String(row.classification_artifact))) : null
            // Preserve raw imports for audit, but send only normalized answers.
            // Extra imported fields must not bypass the sanitized-source tools.
            const classification = rawClassification ? { model: rawClassification.model, answers: rawClassification.answers } : null
            const prior = task.result ? await getArtifact(run, String(task.result)) : null
            const context = { task: { id: task.id, attempt: task.attempt, role: task.role, theme: task.theme, codePurpose: task.purpose }, function: { id: fn.id, file: fn.file, start: fn.start, end: fn.end, name: fn.name }, classification, prior, instructions: 'Use read_source for cited code; do not assume classification labels establish related flows.' }
            const requestHash = await putArtifact(run, context)
            await store.execute('UPDATE attempts SET request_artifact=? WHERE id=?', [requestHash, String(task.attempt)])
            await backend.execute(task, context, gateway, signal)
            if (!gateway.accepted) throw new Error('missing_structured_result')
            const result = { ...gateway.accepted, role: task.role, taskId: task.id, attempt: task.attempt, observedAt: new Date().toISOString(), usage: gateway.usage(), agent: identity, modelEvidenceNotRuntimeProof: true }
            const resultHash = await putArtifact(run, result)
            await finishTask(store, task, resultHash, gateway.accepted)
          } catch (error) {
            const code = errorCode(error)
            await failTask(store, task, code)
            await store.execute("INSERT INTO events(task_id,kind,data,time) VALUES (?,'attempt_failed',?,?)", [String(task.id), JSON.stringify({ code, attempt: task.attempt, usage: gateway.usage() }), Date.now()])
            if (['provider_authentication_failed', 'provider_billing_blocked', 'provider_rate_limited', 'provider_unavailable'].includes(code)) blockReason = code
          } finally { gateway.close() }
        }
      }
      await Promise.all(Array.from({ length: workers }, () => work()))
      await store.set('blockReason', blockReason)
      return { tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state'), modelCalls: await store.get('modelCalls'), compiler: navigation.workspaces.metrics, aborted: signal.aborted, blockReason, maxModelCalls: limits.maxModelCalls }
    } finally { navigation.close(); await store.close() }
  })
}