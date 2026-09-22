import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { atomicJson, hash, readBounded } from './security.js'
import { Store } from './storage/store.js'

export const validationPlanSchema = z.object({
  taskId: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/),
  command: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0'))).min(1).max(30),
  timeoutMs: z.number().int().min(1000).max(120000),
  expectedObservation: z.string().min(1).max(4000),
  memoryMb: z.number().int().min(64).max(1024).default(256)
}).strict()
export type ValidationPlan = z.infer<typeof validationPlanSchema>

export function sandboxArguments (plan: ValidationPlan, snapshot: string, name: string): string[] {
  if (snapshot.includes(',') || snapshot.includes('\n')) throw new Error('unsupported_mount_path')
  return ['run', '--pull=never', '--name', name, '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user', '65534:65534', '--pids-limit=64', '--cpus=1',
    `--memory=${plan.memoryMb}m`, `--memory-swap=${plan.memoryMb}m`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864', '--workdir', '/work',
    '--mount', `type=bind,source=${snapshot},target=/snapshot,readonly`, '--tmpfs', '/work:rw,nosuid,nodev,size=134217728',
    plan.image, ...plan.command]
}

export async function approveValidation (run: string, file: string): Promise<Record<string, unknown>> {
  const plan = validationPlanSchema.parse(JSON.parse((await readBounded(path.dirname(path.resolve(file)), path.basename(file), 65536)).toString()))
  const store = await Store.open(run)
  try {
    if (await store.get('snapshotId') !== plan.snapshotId || !(await store.query('SELECT id FROM tasks WHERE id=?', [plan.taskId])).length) throw new Error('validation_scope_mismatch')
    const id = hash(JSON.stringify(plan))
    const approval = { id, plan, planHash: id, approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: 'local-network-disabled-container-only' }
    await atomicJson(path.join(run, 'validations', id, 'approval.json'), approval)
    return { approvalId: id, expiresAt: approval.expiresAt }
  } finally { await store.close() }
}

export async function executeValidation (run: string, approvalId: string): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9]{64}$/.test(approvalId)) throw new Error('invalid_approval_id')
  const raw = JSON.parse((await readBounded(run, `validations/${approvalId}/approval.json`, 65536)).toString()) as { plan: unknown, expiresAt: string, planHash: string }
  const plan = validationPlanSchema.parse(raw.plan)
  if (raw.planHash !== hash(JSON.stringify(plan)) || raw.planHash !== approvalId || Date.parse(raw.expiresAt) <= Date.now()) throw new Error('invalid_or_expired_approval')
  const store = await Store.open(run)
  try { if (await store.get('snapshotId') !== plan.snapshotId) throw new Error('validation_scope_mismatch') } finally { await store.close() }
  if (spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000, stdio: 'ignore' }).status !== 0) throw new Error('sandbox_unavailable')
  const staging = await mkdtemp(path.join(os.tmpdir(), 'jeeves-validation-'))
  const stagedSource = path.join(staging, 'source')
  await mkdir(stagedSource, { mode: 0o755 })
  const snapshotStore = await Store.open(run)
  try {
    for await (const file of snapshotStore.scan('files')) {
      const bytes = await readBounded(path.join(run, 'snapshot/source'), String(file.path), 16 * 1024 * 1024)
      if (hash(bytes) !== file.hash) throw new Error('snapshot_hash_mismatch')
      const destination = path.join(stagedSource, String(file.path))
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
      await writeFile(destination, bytes, { mode: 0o444 })
    }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error } finally { await snapshotStore.close() }
  const name = `jeeves-${randomUUID()}`
  const args = sandboxArguments(plan, stagedSource, name)
  const startedAt = new Date().toISOString()
  let output = ''; let truncated = false; let timedOut = false
  let outcome: { exitCode: number | null }
  try { outcome = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST } })
    const collect = (chunk: Buffer) => {
      const remaining = 65536 - Buffer.byteLength(output)
      if (remaining <= 0) { truncated = true; return }
      output += chunk.subarray(0, remaining).toString()
      if (chunk.length > remaining) truncated = true
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      spawnSync('docker', ['rm', '-f', name], { timeout: 5000, stdio: 'ignore' })
      child.kill('SIGKILL')
    }, plan.timeoutMs)
    child.once('error', () => { clearTimeout(timer); reject(new Error('sandbox_failed')) })
    child.once('exit', exitCode => { clearTimeout(timer); resolve({ exitCode }) })
  }) } finally {
    spawnSync('docker', ['rm', '-f', name], { timeout: 5000, stdio: 'ignore' })
    await rm(staging, { recursive: true, force: true })
  }
  const result = { taskId: plan.taskId, approvalId, startedAt, finishedAt: new Date().toISOString(), ...outcome, timedOut, truncated, output, observationRequiresReview: true, note: 'Exit success is not automatic vulnerability reproduction.' }
  await atomicJson(path.join(run, 'validations', approvalId, 'result.json'), result)
  return { approvalId, exitCode: outcome.exitCode, timedOut, truncated, observationRequiresReview: true }
}