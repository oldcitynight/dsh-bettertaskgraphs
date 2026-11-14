// Actual defineTool with fixture implementations of the host services.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createToolDefinitions } from '../tools.mjs'
import { DshTransactionHost, sessionReference, artifactProof, ARTIFACT_MAX_BYTES } from '../host.mjs'
import { initialState, applyEvent, KEY } from '../projection.mjs'
import { TransactionGraph } from '../core.mjs'
import { MemoryGraphStore } from '../store.mjs'
import { seal } from '../journal.mjs'
import { createRemoteContribution } from '../remote.mjs'

test('standalone artifact default stays 16 MiB; a caller can explicitly raise its own bound', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-large-artifact-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'trace.json'), size = 17 * 1024 * 1024, hash = createHash('sha256'), block = Buffer.alloc(65536)
  fs.writeFileSync(file, ''); fs.truncateSync(file, size)
  for (let i = 0; i < size / block.length; i++) hash.update(block)
  const sha256 = hash.digest('hex'), reference = { kind: 'artifact', ref: file, sha256 }
  assert.throws(() => artifactProof(root, reference), e => e.code === 'ARTIFACT_BYTE_LIMIT')
  const large = { maxBytes: 1024 * 1024 * 1024 }
  assert.equal(artifactProof(root, reference, undefined, large).stat.size, String(size))
  assert.throws(() => artifactProof(root, { ...reference, sha256: '0'.repeat(64) }, undefined, large), e => e.code === 'ARTIFACT_CHANGED_OR_HASH_MISMATCH')
  fs.truncateSync(file, ARTIFACT_MAX_BYTES + 1)
  assert.throws(() => artifactProof(root, reference), e => e.code === 'ARTIFACT_BYTE_LIMIT')
})

const graphDefinition = { title: 'Host integration fixture', nodes: [
  { key: 'root', kind: 'container', label: 'Root' },
  { key: 'a', kind: 'leaf', label: 'A', parent: 'root' },
  { key: 'b', kind: 'leaf', label: 'B', parent: 'root' },
], edges: [{ kind: 'route', from: 'a', to: 'b', outcome: 'incomplete' }] }
const errorCode = code => error => error.code === code
function fixture(t, { useSessionWorkspace = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-host-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const session = { id: 'fixture-session', inheritedEventCount: 0, header: { id: 'fixture-session', createdAt: 100, cwd: root } }
  session.deriveMessages = () => []
  const agent = { id: session.id, session, status: 'running' }, definitions = new Map(), events = []
  let state = initialState(session.header), durable = true, persistWrites = true, durableCount = 0, live = true, current = agent, cwd = root, call = 0, owner = 0
  const ctx = { agents: { get: id => live && id === agent.id ? agent : undefined, currentInitiator: () => current },
    sessions: { get: id => live && id === session.id ? session : undefined, flush: async () => {
      if (durable && persistWrites) durableCount = events.length
      return durable
    } },
    sessionPersistence: { identity: Symbol('fixture-backend'), open: async (id, access) => {
      assert.equal(id, session.id); assert.equal(access, 'read')
      return { id, access, header: session.header, inheritedEventCount: 0,
        read: async (offset, length) => ({ events: structuredClone(events.slice(offset, Math.min(offset + length, durableCount))) }), close: async () => {} }
    } },
    workingDirectory: { get: () => cwd, ensure: async () => cwd },
    sessionProjections: { stateOf: (_session, key) => key === KEY ? state : undefined },
    get: key => key === 'workingDirectory' ? ctx.workingDirectory : undefined, tools: { get: name => definitions.get(name) }, logger: { warn() {} } }
  function append(type, data) {
    const event = { seq: events.length, type, data, time: 100 + events.length }
    events.push(event); state = applyEvent(state, event); return event.seq
  }
  let host
  function mount() {
    host = new DshTransactionHost(ctx, { projectRoot: useSessionWorkspace ? undefined : root, owner: `owner_fixture_${++owner}`,
      appendPluginRecord: (_session, type, data) => append(type, data) })
    definitions.clear()
    for (const definition of createToolDefinitions({ defineTool, hostPort: host })) {
      definitions.set(definition.name, definition); host.definitions.set(definition.name, definition)
    }
    return host
  }
  mount(); append('turn/start', { turn: 1 })
  function exec(name, callId, rootCallId, parent) {
    return { name, agent, callId, rootCallId: rootCallId ?? callId, token: Object.freeze({ token: callId }),
      ...(parent ? { parent } : {}), signal: new AbortController().signal }
  }
  function result(callId, value = {}, isError = false) {
    return append('tool/result', { turn: state.turn, step: 0, message: { role: 'tool', source: { kind: 'tool', callId },
      content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } })
  }
  async function start(suffix, args, rootCallId, parent) {
    const name = 'transaction_graph_' + suffix, callId = 'call_' + ++call
    if (!rootCallId) append('tool/call', { turn: state.turn, step: 0, callId, name, arguments: JSON.stringify(args) })
    const execution = exec(name, callId, rootCallId, parent), running = host.running.get(agent) ?? new Set()
    running.add(execution); host.running.set(agent, running)
    try {
      const value = await definitions.get(name).execute(args, execution)
      return { callId, name, value }
    } catch (error) { if (!rootCallId) result(callId, { error: error.code ?? error.message }, true); throw error }
    finally { running.delete(execution) }
  }
  async function finishCall(staged, isError = false) {
    result(staged.callId, staged.value, isError)
    await host.schedule(session)
  }
  async function callTool(suffix, args) { const staged = await start(suffix, args); await finishCall(staged); return staged.value }
  async function createAndBegin() {
    await callTool('create', { expectedRevision: 0, definition: graphDefinition })
    await callTool('begin', { expectedRevision: 1, choice: 0 })
  }
  function external(name = 'fixture_check', value = { ok: true }, isError = false) {
    const callId = 'external_' + ++call
    append('tool/call', { turn: state.turn, step: 0, callId, name, arguments: '{}' })
    return result(callId, value, isError)
  }
  function reference(seq) { return { kind: 'tool_result', ref: sessionReference(session.id, seq) } }
  function saved() { return host.journal(session).journal.read() }
  return { root, session, agent, ctx, events, append, result, start, finishCall, callTool, createAndBegin, external, reference, saved,
    get host() { return host }, get state() { return state }, mount, exec,
    setDurable: value => { durable = value }, setLive: value => { live = value },
    setPersistWrites: value => { persistWrites = value },
    setInitiator: value => { current = value }, setCwd: value => { cwd = value },
  }
}

test('bundle uses the original session workspace and keeps the journal there', async t => {
  const f = fixture(t, { useSessionWorkspace: true })
  const subdirectory = fs.mkdtempSync(path.join(f.root, 'subdirectory-'))
  f.setCwd(subdirectory)
  assert.equal(f.host.snapshot(f.session).status, 'empty')
  assert.match(f.host.context(f.agent), /"graph":null/)
  await f.createAndBegin()
  const { binding, key } = f.host.journal(f.session)
  assert.equal(binding.projectRoot, f.root)
  assert.ok(fs.existsSync(path.join(f.root, '.dsh', 'transaction-graphs-v4', key, 'transaction-host-journal.json')))
  assert.equal(f.host.snapshot(f.session).graph.revision, 2)
  assert.match(f.host.context(f.agent), /"revision":2/)
  f.setCwd(path.dirname(f.root))
  assert.equal(f.host.inProject(f.session), false)
  assert.throws(() => f.host.journal(f.session), errorCode('PATH_OUTSIDE_OWN_PROJECT'))
})

test('generic presence distinguishes no graph from loss after a durable commit', async t => {
  const f = fixture(t)
  assert.equal(f.host.presence(f.session).state, 'NEVER_CREATED')
  await f.createAndBegin()
  assert.equal(f.host.presence(f.session).state, 'PRESENT')
  const { binding, key } = f.host.journal(f.session)
  fs.unlinkSync(path.join(binding.projectRoot, '.dsh', 'transaction-graphs-v4', key, 'transaction-host-journal.json'))
  const result = f.host.presence(f.session)
  assert.equal(result.state, 'LOST_OR_INVALID_AFTER_COMMIT'); assert.equal(result.previouslyCommitted, true)
  await assert.rejects(f.callTool('create', { expectedRevision: 0, definition: graphDefinition }), /HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION/)
})

test('real defineTool generates all five DSLs; mutation stays pending until durable actual tool result', async t => {
  const f = fixture(t), staged = await f.start('create', { expectedRevision: 0, definition: graphDefinition })
  assert.equal(staged.value.state, 'PENDING_HOST_COMMIT')
  assert.equal(f.saved().document, null); assert.ok(f.saved().pending)
  await f.finishCall(staged)
  assert.equal(f.saved().document.revision, 1); assert.equal(f.saved().pending, null)
  assert.equal(f.saved().claims.at(-1).status, 'COMMITTED')
})
test('browser snapshot reads only its session and preserves active, failed and blocked state', async t => {
  const f = fixture(t), storage = path.join(f.root, '.dsh/transaction-graphs-v4')
  const schema = createRemoteContribution(z).descriptors[0].result.create()
  assert.deepEqual(schema.parse(f.host.snapshot(f.session)), { sessionId: f.session.id, status: 'empty', graph: null })
  assert.equal(fs.existsSync(storage), false)
  await f.createAndBegin()
  const failed = f.external('fixture_check', { status: 'FAIL' })
  const staged = await f.start('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'FAILED',
    evidence: [f.reference(failed)], note: 'private diagnostic' })
  const journal = path.join(storage, fs.readdirSync(storage)[0], 'transaction-host-journal.json')
  const before = fs.readFileSync(journal), eventCount = f.events.length
  const pending = schema.parse(f.host.snapshot(f.session)).graph
  assert.deepEqual(pending.pending, { operation: 'finish', qualification: 'PENDING' })
  assert.equal(pending.active.recoveryRequired, false)
  assert.deepEqual(pending.legalNext, [])
  assert.deepEqual(pending.skipChoices, [])
  assert.equal(f.events.length, eventCount)
  assert.deepEqual(fs.readFileSync(journal), before)
  await f.finishCall(staged)
  const graph = schema.parse(f.host.snapshot(f.session)).graph
  const decision = graph.nodes.find(row => row.label === 'A')
  const continuation = graph.nodes.find(row => row.label === 'B')
  assert.equal(decision.disposition, 'FAILED')
  assert.deepEqual(decision.selectedBranch, { outcome: 'incomplete', targetId: continuation.id })
  assert.equal(continuation.branchState, 'SELECTED')
  assert.equal(graph.legalNext[0].id, continuation.id)
  assert.equal(decision.parent, graph.nodes.find(row => row.label === 'Root').id)
  assert.equal(JSON.stringify(graph).includes('private diagnostic'), false)
  await f.callTool('begin', { expectedRevision: 3, choice: graph.legalNext[0].choice })
  const recovered = f.external()
  await f.callTool('finish', { expectedRevision: 4, outcome: 'complete',
    evidence: [f.reference(recovered)], note: 'Selected continuation completed' })
  const closed = schema.parse(f.host.snapshot(f.session)).graph
  assert.equal(closed.nodes.find(row => row.label === 'Root').status, 'COMPLETE')
  assert.equal(closed.nodes.find(row => row.label === 'A').disposition, 'FAILED')
  f.setCwd(path.dirname(f.root))
  assert.equal(schema.parse(f.host.snapshot(f.session)).status, 'unavailable')
})

test('browser snapshot marks unmet prerequisites but not work waiting for the active leaf', async t => {
  const f = fixture(t)
  const definition = {
    title: 'Independent and blocked work',
    nodes: [...graphDefinition.nodes, { key: 'c', kind: 'leaf', label: 'C', parent: 'root' }],
    edges: [{ kind: 'prerequisite', from: 'a', to: 'b' }],
  }
  await f.callTool('create', { expectedRevision: 0, definition })
  await f.callTool('begin', { expectedRevision: 1, choice: 0 })
  const blocked = f.host.snapshot(f.session).graph.nodes
  assert.equal(blocked.find(node => node.label === 'B').blocked, true)
  assert.equal(blocked.find(node => node.label === 'C').blocked, undefined)
  const proof = f.external()
  await f.callTool('finish', { expectedRevision: 2, outcome: 'complete',
    evidence: [f.reference(proof)], note: 'Prerequisite satisfied' })
  const ready = f.host.snapshot(f.session).graph
  const dependent = ready.nodes.find(node => node.label === 'B')
  assert.equal(dependent.blocked, undefined)
  assert.ok(ready.legalNext.some(choice => choice.id === dependent.id))
})

test('browser snapshot reports reopened ACTIVE as recovery required without recording a new operation', async t => {
  const f = fixture(t)
  await f.createAndBegin()
  const before = f.events.length
  f.mount()
  assert.equal(f.host.snapshot(f.session).graph.active.recoveryRequired, true)
  assert.equal(f.events.length, before)
})

test('an active journal cannot reuse a work baseline changed by projection rebuild', async t => {
  const f = fixture(t)
  await f.createAndBegin()
  const begin = f.state.intents.find(row => row.data.operation === 'begin')
  begin.workStartedAtRoot++
  assert.throws(() => f.saved(), errorCode('ACTIVE_BEGIN_WORK_BASELINE_MISMATCH'))
  assert.equal(f.host.snapshot(f.session).status, 'unavailable')
})
test('PTC subtool success with failed root aborts candidate without changing graph', async t => {
  const f = fixture(t)
  await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
  f.append('tool/call', { turn: 1, step: 0, callId: 'root_ptc', name: 'run_code', arguments: '{}' })
  const staged = await f.start('begin', { expectedRevision: 1, choice: 0 }, 'root_ptc')
  f.append('tool/ptc-dispatch', { subCallId: staged.callId, parentCallId: 'root_ptc', rootCallId: 'root_ptc',
    name: staged.name, isError: false, content: [{ type: 'text', text: JSON.stringify(staged.value) }] })
  f.result('root_ptc', { failure: 'fixture parent' }, true)
  await f.host.schedule(f.session)
  assert.equal(f.saved().document.revision, 1); assert.equal(f.saved().document.state.active, null)
  assert.equal(f.saved().claims.at(-1).status, 'ABORTED')
})
test('caught failed intermediate PTC parent cannot be hidden by root success', async t => {
  const f = fixture(t)
  await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
  f.append('tool/call', { turn: 1, step: 0, callId: 'root_nested', name: 'run_code', arguments: '{}' })
  const staged = await f.start('begin', { expectedRevision: 1, choice: 0 }, 'root_nested')
  for (const [subCallId, parentCallId, name, isError] of [[staged.callId, 'middle', staged.name, false], ['middle', 'root_nested', 'run_code', true]])
    f.append('tool/ptc-dispatch', { subCallId, parentCallId, rootCallId: 'root_nested', name, isError, content: [] })
  f.result('root_nested', { caught: true })
  await f.host.schedule(f.session)
  assert.equal(f.saved().claims.at(-1).status, 'ABORTED'); assert.equal(f.saved().document.revision, 1)
})
test('all real nested PTC parents successful permits exactly one graph commit', async t => {
  const f = fixture(t)
  await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
  f.append('tool/call', { turn: 1, step: 0, callId: 'root_success', name: 'run_code', arguments: '{}' })
  const staged = await f.start('begin', { expectedRevision: 1, choice: 0 }, 'root_success')
  for (const [subCallId, parentCallId, name] of [[staged.callId, 'middle_success', staged.name], ['middle_success', 'root_success', 'run_code']])
    f.append('tool/ptc-dispatch', { subCallId, parentCallId, rootCallId: 'root_success', name, isError: false, content: [] })
  f.result('root_success', { ok: true }); await f.host.schedule(f.session); await f.host.schedule(f.session)
  assert.equal(f.saved().document.revision, 2)
  assert.equal(f.saved().document.events.filter(event => event.type === 'BEGUN').length, 1)
})
test('complete needs actual own successful tool evidence after begin; Goal remains independent', async t => {
  const f = fixture(t); await f.createAndBegin()
  const seq = f.external()
  await f.callTool('finish', { expectedRevision: 2, outcome: 'complete', evidence: [f.reference(seq)], note: 'Inspection finished' })
  assert.equal(f.saved().document.state.active, null)
  assert.equal(Object.values(f.saved().document.state.leaves).filter(row => row.status === 'COMPLETE').length, 1)
  const read = await f.callTool('read', {})
  assert.equal(read.goalReached, false); assert.equal(read.lastToolClaim.status, 'COMMITTED')
})
test('old, foreign, failed, UNKNOWN or NOT_RUN evidence cannot complete an active leaf', async t => {
  for (const kind of ['old', 'foreign', 'failed', 'UNKNOWN', 'NOT_RUN']) {
    const f = fixture(t), old = f.external()
    await f.createAndBegin()
    const seq = kind === 'old' ? old : f.external('fixture_check', kind === 'UNKNOWN' || kind === 'NOT_RUN' ? { status: kind } : { ok: true }, kind === 'failed')
    const ref = kind === 'foreign' ? { kind: 'tool_result', ref: sessionReference('other-session', seq) } : f.reference(seq)
    await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'complete', evidence: [ref], note: 'Invalid evidence fixture' }))
    assert.equal(f.saved().document.revision, 2); assert.equal(f.saved().pending, null)
  }
})
test('UNKNOWN pending root survives turn end and restart; no dependency or replay is admitted', async t => {
  const f = fixture(t); await f.start('create', { expectedRevision: 0, definition: graphDefinition })
  f.append('turn/end', { turn: 1 }); await f.host.close(); f.mount(); f.append('turn/start', { turn: 2 })
  const read = await f.callTool('read', {})
  assert.equal(read.pendingIntent.rootAndParentQualification, 'UNKNOWN')
  await assert.rejects(f.callTool('begin', { expectedRevision: 0, choice: 0 }), errorCode('PENDING_INTENT_REQUIRES_RECONCILIATION'))
  assert.equal(f.saved().document, null); assert.equal(f.saved().claims.length, 0)
})
test('real DSH synthetic interruption error is UNKNOWN, never a failed-root license to abort/replay', async t => {
  const f = fixture(t), staged = await f.start('create', { expectedRevision: 0, definition: graphDefinition })
  f.append('tool/result', { turn: 1, step: 0, message: { role: 'tool', source: { kind: 'tool', callId: staged.callId },
    isError: true, content: [{ type: 'text', text: 'The original outcome is unknown.' }] },
  error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } })
  await f.host.schedule(f.session)
  assert.equal(f.saved().claims.length, 0); assert.ok(f.saved().pending); assert.equal(f.saved().document, null)
  assert.equal(f.state.intents[0].status, 'UNKNOWN')
})
test('ACTIVE restart never replays; trusted operator may only abandon as incomplete, activates that route', async t => {
  const f = fixture(t); await f.createAndBegin(); const attempt = f.saved().document.state.active.attemptId
  await f.host.close(); f.mount()
  const read = await f.callTool('read', {}); assert.equal(read.active.recoveryRequired, true)
  await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'UNSATISFIED', evidence: [], note: 'Model may not self-authorize recovery' }), errorCode('ACTIVE_RESTART_REQUIRES_EXPLICIT_OPERATOR_RECONCILIATION'))
  await assert.rejects(f.host.recoverInterrupted(f.agent, { expectedRevision: 2, expectedAttemptId: attempt, note: 'Operator review' }), errorCode('TRUSTED_OPERATOR_RECOVERY_REQUIRED'))
  f.host.registerRecoveryVerifier({ version: 'fixture-operator-v1', verify: async request => request.active.attemptId === attempt && request.outcome === 'incomplete' })
  const recovered = await f.host.recoverInterrupted(f.agent, { expectedRevision: 2, expectedAttemptId: attempt, note: 'Operator confirmed original execution ended; retain incomplete outcome' })
  assert.equal(recovered.active, null); assert.deepEqual(recovered.legalNext.map(row => row.label), ['B'])
  assert.equal(f.saved().document.events.at(-1).type, 'RECONCILED')
  assert.equal(f.saved().document.events.filter(event => event.type === 'BEGUN').length, 1)
})
test('failed session durability cannot produce a journal graph commit', async t => {
  const f = fixture(t); f.setDurable(false)
  await assert.rejects(f.callTool('create', { expectedRevision: 0, definition: graphDefinition }), errorCode('DURABLE_SESSION_FLUSH_LISTENER_REQUIRED'))
  assert.equal(f.saved().document, null); assert.ok(f.saved().pending)
})
test('no-op successful flush listener without actual stored event is rejected', async t => {
  const f = fixture(t); f.setPersistWrites(false)
  await assert.rejects(f.callTool('create', { expectedRevision: 0, definition: graphDefinition }), errorCode('DURABLE_SESSION_EVENT_PROOF_REQUIRED'))
  assert.equal(f.saved().document, null); assert.ok(f.saved().pending)
})
test('recovered durable successful root applies only its program candidate, no model work replay', async t => {
  const f = fixture(t), staged = await f.start('create', { expectedRevision: 0, definition: graphDefinition })
  f.result(staged.callId, staged.value)
  await f.host.close(); f.mount()
  await f.callTool('read', {}); await f.callTool('read', {})
  assert.equal(f.saved().document.revision, 1); assert.equal(f.saved().document.events.length, 1)
  assert.equal(f.saved().claims.length, 1)
  assert.equal(f.events.filter(event => event.type === 'tool/call' && event.data.name === 'transaction_graph_create').length, 1)
})
test('same actual scoped callId cannot reserve or execute its graph mutation twice', async t => {
  const f = fixture(t), staged = await f.start('create', { expectedRevision: 0, definition: graphDefinition })
  await f.finishCall(staged)
  f.append('tool/call', { turn: 1, step: 0, callId: staged.callId, name: staged.name, arguments: '{}' })
  const definition = f.ctx.tools.get(staged.name)
  await assert.rejects(definition.execute({ expectedRevision: 1, definition: graphDefinition }, {
    name: staged.name, agent: f.agent, callId: staged.callId, signal: new AbortController().signal,
  }), errorCode('HOST_TOOL_CALL_REPLAY'))
  assert.equal(f.saved().document.revision, 1)
})
test('artifact symlinks escaping own project are rejected before any candidate reserve', async t => {
  const f = fixture(t); await f.createAndBegin(); const seq = f.external()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-artifact-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'file.txt'), 'fixture')
  fs.symlinkSync(path.join(outside, 'file.txt'), path.join(f.root, 'escape.txt'))
  await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'complete', note: 'Invalid path',
    evidence: [f.reference(seq), { kind: 'artifact', ref: 'escape.txt', sha256: '0'.repeat(64) }] }), errorCode('PROJECT_SYMLINK_REJECTED'))
  assert.equal(f.saved().document.revision, 2); assert.equal(f.saved().pending, null)
})
test('changed artifact rejects candidate but preserves successful root result and ACTIVE, never rewrites transport', async t => {
  const f = fixture(t); await f.createAndBegin(); const seq = f.external()
  const file = path.join(f.root, 'artifact.txt'); fs.writeFileSync(file, 'first')
  const sha = createHash('sha256').update('first').digest('hex')
  const staged = await f.start('finish', { expectedRevision: 2, outcome: 'complete', evidence: [f.reference(seq), { kind: 'artifact', ref: 'artifact.txt', sha256: sha }], note: 'Fixture artifact snapshot' })
  fs.writeFileSync(file, 'changed'); await f.finishCall(staged)
  assert.equal(f.saved().claims.at(-1).status, 'ABORTED')
  assert.match(f.saved().claims.at(-1).reason, /evidence failed revalidation/)
  assert.equal(f.saved().document.revision, 2); assert.ok(f.saved().document.state.active)
  assert.equal(f.events.findLast(event => event.type === 'tool/result').data.message.isError, undefined)
})
test('wrong initiator/effective cwd and missing journal cannot silently acquire another scope', async t => {
  const f = fixture(t); f.setInitiator({ id: f.agent.id })
  await assert.rejects(f.callTool('read', {}), errorCode('EXACT_CALLING_AGENT_REQUIRED'))
  f.setInitiator(f.agent); await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
  const journal = f.host.journal(f.session).journal
  fs.unlinkSync(journal.store.file)
  await assert.rejects(f.callTool('read', {}), errorCode('HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION'))
})
test('rehashed fabricated graph file cannot replace the actual session-anchored candidate', async t => {
  const f = fixture(t); await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
  const journal = f.host.journal(f.session).journal, state = journal.read()
  let id = 0
  const fakeStore = new MemoryGraphStore(state.document), fake = new TransactionGraph(fakeStore, {
    id: prefix => prefix === 'owner' ? f.host.owner : `${prefix}_fabricated_${++id}` })
  fake.begin({ expectedRevision: 1, operationId: 'fabricated_begin', choice: 0 })
  fake.finish({ expectedRevision: 2, operationId: 'fabricated_finish', outcome: 'complete', note: 'Not an actual session tool result',
    evidence: [{ kind: 'tool_result', ref: 'invented-reference' }] })
  fs.writeFileSync(journal.store.file, JSON.stringify(seal({ ...state, document: fakeStore.read() })))
  await assert.rejects(f.callTool('read', {}), errorCode('GRAPH_NOT_ANCHORED_TO_COMMITTED_CANDIDATE'))
})
test('typed false/NOT_RUN/UNKNOWN at middle or root cannot commit a successful-looking subtool claim', async t => {
  for (const location of ['middle', 'root']) for (const status of ['FAIL', 'NOT_RUN', 'UNKNOWN']) {
    const f = fixture(t)
    await f.callTool('create', { expectedRevision: 0, definition: graphDefinition })
    f.append('tool/call', { turn: 1, step: 0, callId: 'typed_root', name: 'run_code', arguments: '{}' })
    const staged = await f.start('begin', { expectedRevision: 1, choice: 0 }, 'typed_root')
    const negative = status === 'FAIL' ? { ok: false } : { status }
    f.append('tool/ptc-dispatch', { subCallId: staged.callId, parentCallId: 'typed_middle', rootCallId: 'typed_root',
      name: staged.name, isError: false, content: [{ type: 'text', text: JSON.stringify(staged.value) }] })
    f.append('tool/ptc-dispatch', { subCallId: 'typed_middle', parentCallId: 'typed_root', rootCallId: 'typed_root',
      name: 'run_code', isError: false, content: [{ type: 'text', text: JSON.stringify(location === 'middle' ? negative : { ok: true }) }] })
    f.result('typed_root', location === 'root' ? negative : { ok: true })
    await f.host.schedule(f.session)
    assert.equal(f.saved().document.revision, 1)
    if (status === 'UNKNOWN') {
      assert.ok(f.saved().pending); assert.equal(f.saved().claims.length, 1)
      assert.equal(f.state.intents.find(row => row.data.callId === staged.callId).status, 'UNKNOWN')
    } else {
      assert.equal(f.saved().pending, null); assert.equal(f.saved().claims.at(-1).status, 'ABORTED')
    }
    assert.equal(f.events.findLast(event => event.type === 'tool/result' && event.data.message.source.callId === 'typed_root').data.message.isError, undefined)
  }
})
test('otherwise-successful child proof cannot finish a leaf through a typed-negative parent/root', async t => {
  for (const location of ['middle', 'root']) for (const status of ['FAIL', 'NOT_RUN', 'UNKNOWN']) {
    const f = fixture(t); await f.createAndBegin()
    f.append('tool/call', { turn: 1, step: 0, callId: 'evidence_root', name: 'run_code', arguments: '{}' })
    const childSeq = f.append('tool/ptc-dispatch', { subCallId: 'evidence_child', parentCallId: 'evidence_middle', rootCallId: 'evidence_root',
      name: 'fixture_check', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] })
    const negative = status === 'FAIL' ? { passed: false } : { status }
    f.append('tool/ptc-dispatch', { subCallId: 'evidence_middle', parentCallId: 'evidence_root', rootCallId: 'evidence_root',
      name: 'run_code', isError: false, content: [{ type: 'text', text: JSON.stringify(location === 'middle' ? negative : { ok: true }) }] })
    f.result('evidence_root', location === 'root' ? negative : { ok: true })
    const proof = f.state.proofs.find(row => row.seq === childSeq)
    assert.equal(proof.successful, false)
    assert.equal(proof.ownOutcome, 'UNVERIFIED')
    assert.equal(proof.qualification, status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED')
    assert.ok(proof.ancestorOutcomes.some(row => row.outcome === status || status === 'FAIL' && row.outcome === 'FAIL'))
    await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'complete', evidence: [f.reference(childSeq)],
      note: 'A negative ancestor cannot be bypassed' }), errorCode(status === 'UNKNOWN' ? 'ACTIVE_OWNED_WORK_UNRESOLVED' : 'FAILED_UNKNOWN_OR_NOT_RUN_CANNOT_COMPLETE'))
    assert.equal(f.saved().document.revision, 2); assert.ok(f.saved().document.state.active)
  }
})
test('UNKNOWN or truly pending work blocks both finishes even with empty refs and a note', async t => {
  for (const kind of ['UNKNOWN', 'PENDING']) for (const outcome of ['complete', 'incomplete']) {
    const f = fixture(t); await f.createAndBegin()
    if (kind === 'UNKNOWN') f.external('fixture_work', { status: 'UNKNOWN' })
    else f.append('tool/call', { turn: 1, step: 0, callId: 'pending_work', name: 'fixture_work', arguments: '{}' })
    await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome,
      ...(outcome === 'incomplete' ? { disposition: 'UNSATISFIED' } : {}), evidence: [], note: 'Empty refs cannot discard work' }),
    errorCode('ACTIVE_OWNED_WORK_UNRESOLVED'))
    assert.ok(f.saved().document.state.active); assert.equal(f.saved().document.revision, 2)
  }
})
test('UNKNOWN survives proof-index eviction and still blocks an empty-ref incomplete', async t => {
  const f = fixture(t); await f.createAndBegin(); const unknownSeq = f.external('fixture_unknown', { status: 'UNKNOWN' })
  for (let i = 0; i < 1100; i++) f.external('fixture_read', { ok: true })
  assert.equal(f.state.proofs.some(row => row.seq === unknownSeq), false)
  assert.equal(f.state.uncertainties.length, 1)
  await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'UNSATISFIED',
    evidence: [], note: 'Recent index is not the unknown ledger' }), errorCode('ACTIVE_OWNED_WORK_UNRESOLVED'))
  assert.ok(f.saved().document.state.active)
})
test('UNKNOWN goal changes and graph-like names cannot use administrative exclusions', async t => {
  for (const name of ['update_goal', 'transaction_graph_external', 'transaction_graph_read']) {
    const f = fixture(t); await f.createAndBegin()
    f.external(name, { status: 'UNKNOWN' })
    await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'UNSATISFIED',
      evidence: [], note: 'Names do not authorize dropping UNKNOWN' }), errorCode('ACTIVE_OWNED_WORK_UNRESOLVED'))
    assert.ok(f.saved().document.state.active)
  }
})
test('zero-work explicit SKIPPED_NOT_RUN drives incomplete route without inventing a failed tool', async t => {
  const f = fixture(t); await f.createAndBegin()
  await f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'SKIPPED_NOT_RUN', evidence: [], note: 'Proactive skip before any actual work' })
  const read = await f.callTool('read', {})
  assert.equal(read.nodes.find(row => row.key === 'a').status, 'INCOMPLETE')
  assert.equal(read.nodes.find(row => row.key === 'a').disposition, 'SKIPPED_NOT_RUN')
  assert.deepEqual(read.legalNext.map(row => row.label), ['B'])
})
test('known terminal FAIL legitimately drives FAILED incomplete without an operator', async t => {
  const f = fixture(t); await f.createAndBegin(); const failed = f.external('fixture_check', { ok: false })
  await f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'FAILED', evidence: [f.reference(failed)], note: 'The actual check failed' })
  const read = await f.callTool('read', {})
  assert.equal(read.nodes.find(row => row.key === 'a').disposition, 'FAILED')
  assert.deepEqual(read.legalNext.map(row => row.label), ['B'])
})
test('NOT_RUN stays distinct from executed failure and permits explicit non-execution disposition', async t => {
  const f = fixture(t); await f.createAndBegin(); const notRun = f.external('fixture_action', { status: 'NOT_RUN' })
  const proof = f.state.proofs.find(row => row.seq === notRun)
  assert.equal(proof.ownOutcome, 'NOT_RUN'); assert.equal(proof.qualification, 'FAILED'); assert.equal(proof.isError, false)
  await assert.rejects(f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'FAILED', evidence: [f.reference(notRun)], note: 'Do not relabel this as failure' }),
    errorCode('FAILED_DISPOSITION_REQUIRES_KNOWN_TERMINAL_FAILURE'))
  await f.callTool('finish', { expectedRevision: 2, outcome: 'incomplete', disposition: 'SKIPPED_NOT_RUN', evidence: [f.reference(notRun)], note: 'The action was not executed' })
  assert.equal(Object.values(f.saved().document.state.leaves).find(row => row.status === 'INCOMPLETE').disposition, 'SKIPPED_NOT_RUN')
})
test('legal nested finish excludes only actual registry-owned root and parent token ancestors', async t => {
  const f = fixture(t); await f.createAndBegin(); const work = f.external()
  f.append('tool/call', { turn: 1, step: 0, callId: 'nested_root', name: 'run_code', arguments: '{}' })
  const root = f.exec('run_code', 'nested_root'), middle = f.exec('run_code', 'nested_middle', 'nested_root', root.token)
  const running = new Set([root, middle]); f.host.running.set(f.agent, running)
  const staged = await f.start('finish', { expectedRevision: 2, outcome: 'complete', evidence: [f.reference(work)], note: 'Known work through real ancestry' }, 'nested_root', middle.token)
  for (const [subCallId, parentCallId, name] of [[staged.callId, 'nested_middle', staged.name], ['nested_middle', 'nested_root', 'run_code']])
    f.append('tool/ptc-dispatch', { subCallId, parentCallId, rootCallId: 'nested_root', name, isError: false, content: [{ type: 'text', text: '{"ok":true}' }] })
  running.clear(); f.result('nested_root', { ok: true }); await f.host.schedule(f.session)
  assert.equal(f.saved().document.revision, 3); assert.equal(f.saved().document.state.active, null)
})
test('a same-root sibling or unrelated concurrent execution remains a finish blocker', async t => {
  for (const siblingRoot of ['nested_root', 'different_root']) {
    const f = fixture(t); await f.createAndBegin(); const work = f.external()
    f.append('tool/call', { turn: 1, step: 0, callId: 'nested_root', name: 'run_code', arguments: '{}' })
    const root = f.exec('run_code', 'nested_root'), middle = f.exec('run_code', 'nested_middle', 'nested_root', root.token)
    const sibling = f.exec('fixture_work', 'sibling', siblingRoot, siblingRoot === 'nested_root' ? middle.token : undefined)
    const running = new Set([root, middle, sibling]); f.host.running.set(f.agent, running)
    await assert.rejects(f.start('finish', { expectedRevision: 2, outcome: 'complete', evidence: [f.reference(work)], note: 'Sibling cannot be excluded broadly' }, 'nested_root', middle.token),
      errorCode('FINISH_OTHER_OWN_TOOLS_BEFORE_TRANSACTION_FINISH'))
    running.clear(); assert.equal(f.saved().document.revision, 2); assert.ok(f.saved().document.state.active)
  }
})
test('commit-time work scan does not union concurrent graph protocol sibling chains', async t => {
  const f = fixture(t); await f.createAndBegin()
  f.append('tool/call', { turn: 1, step: 0, callId: 'shared_root', name: 'run_code', arguments: '{}' })
  const root = f.exec('run_code', 'shared_root')
  const readA = f.exec('transaction_graph_read', 'read_a', 'shared_root', root.token)
  const readB = f.exec('transaction_graph_read', 'read_b', 'shared_root', root.token)
  f.host.running.set(f.agent, new Set([root, readA, readB]))
  const work = f.host.workState(f.session, f.saved())
  assert.equal(work.running.length, 3); assert.equal(work.unresolved.length, 1)
})
test('current-owner UNKNOWN requires explicit independent cleanup approval and records UNSATISFIED, never fake FAIL', async t => {
  const f = fixture(t); await f.createAndBegin(); const unknown = f.external('fixture_action', { status: 'UNKNOWN' })
  const attempt = f.saved().document.state.active.attemptId
  let cleaned = false
  f.host.registerRecoveryVerifier({ version: 'fixture-cleanup-facts-v1', verify: async request => cleaned && request.unresolvedOwnedWork.length === 1 && request.runningWorkCount === 0 })
  const request = { expectedRevision: 2, expectedAttemptId: attempt, note: 'Independent host cleanup facts required' }
  await assert.rejects(f.host.recoverInterrupted(f.agent, request), errorCode('RECOVERY_APPROVAL_NOT_CURRENT'))
  assert.ok(f.saved().document.state.active)
  cleaned = true; const result = await f.host.recoverInterrupted(f.agent, request)
  assert.equal(result.active, null); assert.equal(f.state.uncertainties.length, 0); assert.equal(f.state.acknowledgedWork.length, 1)
  assert.equal(f.state.proofs.find(row => row.seq === unknown).ownOutcome, 'UNKNOWN')
  assert.equal(result.nodes.find(row => row.key === 'a').disposition, 'UNSATISFIED')
})
