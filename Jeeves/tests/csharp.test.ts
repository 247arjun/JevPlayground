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
    const resolved = await client.request('resolve', { project: 'Example.csproj', file: 'Example.cs', start: result.calls[0]!.start }) as { targets: Array<{ id: string, file: string, implementation: boolean }>, reasons: string[] }
    assert.ok(resolved.targets.some(target => target.file === 'Example.cs' && target.implementation))
    assert.ok(resolved.reasons.includes('build_conditions_not_evaluated'))
    const reverse = await client.request('callers', { project: 'Example.csproj', targetId: resolved.targets[0]!.id, limit: 10 }) as { rows: Array<{ file: string }>, reasons: string[] }
    assert.equal(reverse.rows[0]?.file, 'Example.cs')
    assert.ok(reverse.reasons.includes('dynamic_dispatch_not_exhaustive'))
    const methodStart = source.indexOf('static string Target')
    const methodEnd = source.indexOf('} static') + 1
    const local = await client.request('local', { file: 'Example.cs', start: methodStart, end: methodEnd }) as { blocks: unknown[] }
    assert.ok(local.blocks.length > 0)
    await writeFile(path.join(root, 'Endpoint.cs'), 'using Microsoft.AspNetCore.Authorization; class Endpoint { [Authorize] public void Handle() {} }')
    const framework = await client.request('framework', { file: 'Endpoint.cs' }) as { facts: Array<{ name: string }> }
    assert.equal(framework.facts[0]?.name, 'Authorize')
    await assert.rejects(client.request('analyze', { file: '../outside.cs' }), /invalid_relative_path/)
  } finally { client.close(); await rm(root, { recursive: true, force: true }) }
})