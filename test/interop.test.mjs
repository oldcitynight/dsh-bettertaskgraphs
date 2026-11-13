import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkflowRegistry, WORKFLOW_CONTRACT } from '../interop.mjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-interop-port-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const session = { header: { cwd: root } }, agent = { id: 'controller', session }
  const registry = new WorkflowRegistry({ agents: { get: () => agent }, sessions: { get: () => session }, workingDirectory: { get: () => root } })
  t.after(() => registry.close())
  return { root, registry, agent, adapter: { contract: WORKFLOW_CONTRACT, version: 1, kind: 'fixture', workflowId: 'fixture-one', projectRoot: root,
    operations: ['submit'], authorize: () => true, read: () => ({ revision: 0, graph: null }), execute: async () => ({ accepted: true }) } }
}

test('workflow providers require an exact version, cannot overwrite one another, and release subscriptions', t => {
  const f = fixture(t); let detached = 0
  assert.throws(() => f.registry.register({ ...f.adapter, version: 2 }), /WORKFLOW_ADAPTER_CONTRACT_REQUIRED/)
  const dispose = f.registry.register({ ...f.adapter, subscribe: () => () => { detached++ } })
  assert.throws(() => f.registry.register(f.adapter), /WORKFLOW_PROVIDER_ALREADY_REGISTERED/)
  assert.equal(f.registry.list(f.agent).length, 1)
  dispose(); dispose(); assert.equal(detached, 1)
  f.registry.register({ ...f.adapter, subscribe: () => () => { detached++ } })
  f.registry.close(); assert.equal(detached, 2)
})

test('unregistering an in-flight provider cancels dispatch and prevents a stale result from being accepted', async t => {
  const f = fixture(t)
  let entered, release
  const ready = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const dispose = f.registry.register({ ...f.adapter, execute: async (_operation, _request, { signal }) => {
    entered(); await gate; signal.throwIfAborted(); return { accepted: true }
  } })
  const task = f.registry.dispatch(f.agent, { kind: f.adapter.kind, workflowId: f.adapter.workflowId }, 'submit', {})
  await ready; dispose(); release()
  await assert.rejects(task, /WORKFLOW_PROVIDER_DISPOSED/)
})

test('workflow snapshots cannot advertise a graph revision without the actual validated graph', t => {
  const f = fixture(t)
  f.registry.register({ ...f.adapter, read: () => ({ revision: 5, graph: null }) })
  assert.throws(() => f.registry.read(f.agent, { kind: f.adapter.kind, workflowId: f.adapter.workflowId }), /WORKFLOW_INVALID_SNAPSHOT/)
})
