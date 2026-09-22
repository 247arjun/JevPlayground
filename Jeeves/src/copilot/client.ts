import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { CopilotClient, ToolSet, type SessionConfig, type PermissionRequestResult } from '@github/copilot-sdk'

export function permission (request: { kind: string, toolName?: string, managedApprovalRequired?: boolean }, names: Set<string>): PermissionRequestResult {
  if (!request.managedApprovalRequired && request.kind === 'custom-tool' && request.toolName && names.has(request.toolName)) return { kind: 'approve-once' }
  return { kind: 'reject', feedback: 'Only explicitly scoped Jeeves tools are allowed.' }
}

export function sessionConfiguration (workingDirectory: string, model: string, tools: NonNullable<SessionConfig['tools']>, instructions: string): SessionConfig {
  const names = new Set(tools.map(tool => tool.name))
  const allowed = new ToolSet()
  for (const name of names) allowed.addCustom(name)
  return {
    model, workingDirectory, configDirectory: workingDirectory,
    tools, availableTools: allowed, excludedTools: ['builtin:*', 'mcp:*'],
    enableConfigDiscovery: false, skipCustomInstructions: true,
    memory: { enabled: false }, enableSessionStore: false,
    infiniteSessions: { enabled: false }, customAgents: [], mcpServers: {}, skillDirectories: [],
    includedBuiltinSkills: [], enableSessionTelemetry: false, enableFileChangeTracking: false,
    requestExtensions: false, manageScheduleEnabled: false, coauthorEnabled: false,
    systemMessage: { mode: 'replace', content: instructions },
    onPermissionRequest: request => permission(request, names),
    hooks: { onPreToolUse: input => ({ permissionDecision: names.has(input.toolName) ? 'allow' : 'deny' }) }
  }
}

export async function createClient (root: string): Promise<CopilotClient> {
  const home = path.resolve(root, 'runtime/home')
  const workingDirectory = path.resolve(root, 'runtime/work')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 })
  const env: Record<string, string | undefined> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_CLI_PATH']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const client = new CopilotClient({ mode: 'empty', baseDirectory: home, workingDirectory, env,
    logLevel: 'error', enableRemoteSessions: false, useLoggedInUser: true,
    clientInfo: { applicationName: 'jeeves', applicationVersion: '0.1.0' } })
  try { await bounded(client.start(), 20000, () => client.forceStop()) } catch (error) { await client.forceStop(); throw error }
  return client
}

export async function bounded<T> (work: Promise<T>, milliseconds: number, onTimeout: () => Promise<unknown>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first, but explicitly cancel the runtime as well: waiting and
      // execution have different lifecycles in the SDK.
      void onTimeout().catch(() => {})
      reject(new Error('model_timeout'))
    }, milliseconds)
  })
  try { return await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
}

export async function stopClient (client: CopilotClient): Promise<void> {
  try { await bounded(client.stop(), 5000, () => client.forceStop()) } catch { await client.forceStop() }
}