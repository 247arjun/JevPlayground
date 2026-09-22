import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CSharp, sidecarPath } from '../src/analysis/csharp.js'

test('Roslyn sidecar masks comments, indexes calls and resolves a local implementation', { skip: !existsSync(sidecarPath) && 'Run npm run build:dotnet for C# integration tests' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jeeves-csharp-'))
  const client = new CSharp(root)
  try {
    const source = 'class Example { static string Target(string value) { /* hint */ return value; } static string Caller() { return Target("https://example.test/*literal*/"); } }'
    await writeFile(path.join(root, 'Example.cs'), source)
    await writeFile(path.join(root, 'Example.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')
    const read = await client.request('read', { file: 'Example.cs', start: 0, end: source.length }) as { text: string }
    assert.equal(read.text.length, source.length)
    assert.ok(!read.text.includes('hint'))
    assert.ok(read.text.includes('https://example.test/*literal*/'))
    const result = await client.request('analyze', { file: 'Example.cs' }) as { calls: Array<{ name: string, start: number }> }
    assert.equal(result.calls[0]?.name, 'Target')
    const resolved = await client.request('resolve', { project: 'Example.csproj', file: 'Example.cs', start: result.calls[0]!.start }) as { targets: Array<{ file: string, implementation: boolean }>, reasons: string[] }
    assert.ok(resolved.targets.some(target => target.file === 'Example.cs' && target.implementation))
    assert.ok(resolved.reasons.includes('build_conditions_not_evaluated'))
    await assert.rejects(client.request('analyze', { file: '../outside.cs' }), /invalid_relative_path/)
  } finally { client.close(); await rm(root, { recursive: true, force: true }) }
})