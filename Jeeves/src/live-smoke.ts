import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@github/copilot-sdk'
import { z } from 'zod'
import { bounded, createClient, sessionConfiguration, stopClient } from './copilot/client.js'
import { errorCode } from './security.js'

async function main (): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-sdk-gate-'))
  const client = await createClient(root)
  try {
    const available = await client.listModels()
    const model = process.env.JEEVES_MODEL ?? available.find(item => item.id === 'gpt-5-mini')?.id ?? available.find(item => item.id === 'gpt-4.1')?.id
    if (!model || !available.some(item => item.id === model)) throw new Error('model_unavailable')
    for (let index = 0; index < 2; index++) {
      const nonce = randomUUID()
      let submitted = false
      const tools = [defineTool('read_probe', { description: 'Read the isolated probe value', parameters: z.object({}).strict(), handler: async () => ({ nonce }) }),
        defineTool('submit_probe', { description: 'Submit the probe value', parameters: z.object({ nonce: z.string() }).strict(), handler: async input => { assert.equal(input.nonce, nonce); submitted = true; return { accepted: true } } })]
      const session = await client.createSession(sessionConfiguration(path.join(root, 'runtime/work'), model, tools,
        'Use read_probe and then submit_probe with its value. Do not use any other tools. Stop after submission.'))
      try {
        await bounded(session.sendAndWait({ prompt: 'Run the probe now.' }, 60000), 65000, () => session.abort())
        assert.ok(submitted, 'Custom tool result was not submitted')
      } finally { await session.disconnect() }
    }
    console.log(JSON.stringify({ status: 'passed', model, sessions: 2, customToolRoundTrip: true, repositorySourceSent: false }))
  } finally { await stopClient(client); await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })