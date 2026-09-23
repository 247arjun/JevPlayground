import { parentPort, workerData } from 'node:worker_threads'
import { readBounded, errorCode } from '../security.js'
import { syntaxIndex } from './syntax.js'
import { contextEvidence } from './context.js'

parentPort!.on('message', async (message: { id: number, file: string, kind?: string, language?: string }) => {
  try {
    const source = (await readBounded(workerData.root as string, message.file, 16 * 1024 * 1024)).toString()
    const value = message.kind === 'context' ? contextEvidence(message.file, source, message.language ?? 'configuration') : syntaxIndex(message.file, source)
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('syntax_result_limit')
    parentPort!.postMessage({ id: message.id, value })
  } catch (error) { parentPort!.postMessage({ id: message.id, error: errorCode(error) }) }
})