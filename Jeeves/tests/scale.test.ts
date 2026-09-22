import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { benchmark } from '../src/benchmark.js'
import { Workspaces } from '../src/analysis/workspaces.js'
import { defaultLimits } from '../src/domain.js'

test('high fan-out lookup pages 10,000 sites exactly once using an index', async () => {
  const result = await benchmark(10000)
  assert.equal(result.returned, 10000)
  assert.equal(result.pages, 100)
  assert.equal(result.indexedLookup, true)
})

test('compiler queue rejects excess work and remains usable after requests finish', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-pressure-'))
  const pool = new Workspaces(root, { ...defaultLimits, maxQueue: 1 })
  try {
    await writeFile(path.join(root, 'tsconfig.json'), '{"files":["code.ts"]}')
    await writeFile(path.join(root, 'code.ts'), 'function target(){}; target(); target();')
    const first = pool.resolve('tsconfig.json', 'code.ts', 21)
    const second = pool.resolve('tsconfig.json', 'code.ts', 31)
    await assert.rejects(pool.resolve('tsconfig.json', 'code.ts', 99), /compiler_backpressure/)
    await Promise.allSettled([first, second])
    assert.ok(pool.metrics.maxResident <= 1)
  } finally { pool.close(); await rm(root, { recursive: true, force: true }) }
})