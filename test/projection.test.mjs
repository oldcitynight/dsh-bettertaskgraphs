import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { initialState, applyEvent, chainSucceeded, chainQualification, outcomeOfContent, INTENT, projection } from '../projection.mjs'

test('fork inherited parent tool evidence and intents never become child-owned state', () => {
  const child = initialState({ id: 'child' }, 10)
  const next = applyEvent(child, { seq: 3, type: 'tool/call', data: { callId: 'parent-call', name: 'fixture', turn: 1 } })
  assert.equal(next, child); assert.equal(next.proofs.length, 0)
})
test('fork synthetic closer of an inherited call neither poisons child nor qualifies evidence', () => {
  const child = initialState({ id: 'child' }, 10)
  const next = applyEvent(child, { seq: 10, type: 'tool/result', data: { message: {
    source: { kind: 'tool', callId: 'parent-call' }, isError: true, content: [] } } })
  assert.equal(next.failure, null); assert.equal(next.proofs.length, 0); assert.equal(next.intents.length, 0)
})
test('unowned PTC dispatches stay outside the child budget and evidence even if a later root has the same ID', () => {
  let state = initialState({ id: 'child' }, 10)
  const rootCallId = 'parent-call'
  state = applyEvent(state, { seq: 3, type: 'tool/call', data: { callId: rootCallId, name: 'run_code' } })
  for (let seq = 10; seq < 310; seq++) {
    state = applyEvent(state, { seq, type: 'tool/ptc-dispatch', data: {
      subCallId: `foreign-${seq}`, parentCallId: rootCallId, rootCallId,
      name: 'unowned_work', isError: false, content: [],
    } })
  }
  assert.equal(state.failure, null)
  assert.equal(state.dispatches.length, 0)
  assert.equal(state.workStarted, 0)
  state = applyEvent(state, { seq: 310, type: 'tool/result', data: { message: { source: { callId: rootCallId }, content: [] } } })
  state = applyEvent(state, { seq: 311, type: 'tool/call', data: { callId: rootCallId, name: 'run_code' } })
  state = applyEvent(state, { seq: 312, type: 'tool/result', data: { message: { source: { callId: rootCallId }, content: [] } } })
  assert.equal(state.failure, null)
  assert.deepEqual(state.proofs.map(row => row.tool), ['run_code'])
})
test('PTC dispatch missing its root fails closed when the root has an unresolved own intent', () => {
  let state = initialState({ id: 'own' })
  state = applyEvent(state, { seq: 0, type: 'turn/start', data: { turn: 1 } })
  state = applyEvent(state, { seq: 1, type: INTENT, data: { version: 4, operationId: 'op_fixture', callId: 'sub',
    rootCallId: 'root', turn: 1, sessionId: 'own', bindingDigest: '0'.repeat(64), claimDigest: '1'.repeat(64),
    operation: 'create', expectedGraphRevision: 0, candidateChecksum: '2'.repeat(64), clearedWork: [] } })
  state = applyEvent(state, { seq: 2, type: 'tool/ptc-dispatch', data: {
    subCallId: 'sub', parentCallId: 'root', name: 'transaction_graph_create', isError: false, content: [],
  } })
  assert.match(state.failure, /UNATTRIBUTED_PTC_DISPATCH_IN_GRAPH_SESSION/)
  assert.equal(state.intents[0].status, 'PENDING')
  assert.equal(state.dispatches.length, 0)
})
test('registry restores a v4 checkpoint by rebuilding the original log under v6', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    const registry = ctx.sessionProjections
    registry.register(projection)
    const header = { id: 'child' }
    const cached = { ...initialState(header), failure: 'PTC_DISPATCH_REPLAY_OR_LIMIT' }
    const checkpoint = { [projection.key]: { ver: 4, seq: 1, val: cached } }
    const events = [
      { seq: 0, type: 'tool/ptc-dispatch', data: { parentCallId: 'foreign', subCallId: 'child', name: 'fixture', isError: false, content: [] } },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
    ]
    assert.equal(registry.restoreFloor(checkpoint), 0)
    assert.throws(() => registry.restore(checkpoint, events.slice(1), 1, header, 0), /re-read from seq 0/)
    const restored = registry.restore(checkpoint, events, 0, header, 0).checkpoint[projection.key]
    assert.equal(restored.ver, 6)
    assert.equal(restored.val.failure, null)
    assert.equal(restored.val.dispatches.length, 0)
    assert.equal(restored.val.turn, 1)
    assert.equal(checkpoint[projection.key].val.failure, 'PTC_DISPATCH_REPLAY_OR_LIMIT')
  } finally { await ctx.fiber.dispose() }
})
test('the limit applies to concurrent unresolved roots and preserves their evidence', () => {
  let state = initialState({ id: 'own' })
  for (let n = 0; n < 300; n++) {
    const callId = `closed-${n}`
    state = applyEvent(state, { seq: n * 2, type: 'tool/call', data: { callId, name: 'fixture' } })
    state = applyEvent(state, { seq: n * 2 + 1, type: 'tool/result', data: { message: { source: { callId }, content: [] } } })
  }
  assert.equal(state.failure, null)
  assert.equal(Object.keys(state.calls).length, 0)
  assert.equal(state.proofs.length, 300)
  for (let n = 0; n < 257; n++) {
    state = applyEvent(state, { seq: 600 + n, type: 'tool/call', data: { callId: `open-${n}`, name: 'fixture' } })
  }
  assert.match(state.failure, /CALL_ID_REPLAY_OR_LIMIT/)
  assert.equal(Object.keys(state.calls).length, 256)
})
test('new schema cannot silently open an empty graph over an own legacy graph log', () => {
  const state = applyEvent(initialState({ id: 'own' }), { seq: 0, type: 'plugin:project-transaction-graph/intent-v2', data: {} })
  assert.match(state.failure, /LEGACY_GRAPH_REQUIRES_EXPLICIT_MIGRATION/)
})
test('PTC parent cycle, duplicate dispatch and missing ancestry never qualify success', () => {
  const row = (subCallId, parentCallId) => ({ subCallId, parentCallId, rootCallId: 'root', isError: false, outcome: 'UNVERIFIED' })
  assert.equal(chainSucceeded('a', 'root', [row('a', 'b'), row('b', 'a')]), false)
  assert.equal(chainSucceeded('a', 'root', [row('a', 'root'), row('a', 'root')]), false)
  assert.equal(chainSucceeded('a', 'root', []), false)
  assert.equal(chainSucceeded('a', 'root', [row('a', 'b'), row('b', 'root')]), true)
})
test('every PTC parent typed negative qualifies the whole chain, UNKNOWN never becomes failed/replayable', () => {
  const leaf = { subCallId: 'leaf', parentCallId: 'middle', rootCallId: 'root', isError: false, outcome: 'UNVERIFIED' }
  for (const [outcome, expected] of [['FAIL', 'FAILED'], ['NOT_RUN', 'FAILED'], ['UNKNOWN', 'UNKNOWN']]) {
    const parent = { subCallId: 'middle', parentCallId: 'root', rootCallId: 'root', isError: false, outcome }
    assert.equal(chainQualification('leaf', 'root', [leaf, parent]), expected)
    assert.equal(chainSucceeded('leaf', 'root', [leaf, parent]), false)
  }
  assert.equal(projection.stateVersion, 6)
})
test('oversized result is explicitly UNKNOWN, typed false/failure cannot pass as execution evidence', () => {
  assert.equal(outcomeOfContent([{ type: 'text', text: 'x'.repeat(32769) }]), 'UNKNOWN')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"passed":false}' }]), 'FAIL')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"status":"NOT_RUN"}' }]), 'NOT_RUN')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"ok":true}' }]), 'UNVERIFIED')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"ok":false}' }, { type: 'text', text: '{"status":"UNKNOWN"}' }]), 'UNKNOWN')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"ok":false,"status":"NOT_RUN"}' }]), 'UNKNOWN')
  assert.equal(outcomeOfContent([{ type: 'text', text: '{"goalVerification":{"status":"FAIL"},"status":"UNKNOWN"}' }]), 'UNKNOWN')
})
test('owned Bash exit status overrides delivery success for root and PTC tool results', () => {
  for (const nested of [false, true]) {
    for (const exitCode of [0, 1]) {
      let state = initialState({ id: 'own' })
      const add = (type, data) => { state = applyEvent(state, { seq: state.lastSeq + 1, type, data }) }
      const rootCallId = 'root'
      const callId = nested ? 'child' : rootCallId
      const content = [{ type: 'text', text: 'stdout can contain [exit code: 123]' }]
      add('tool/call', { callId: rootCallId, name: nested ? 'run_code' : 'bash' })
      const settlement = { kind: 'bash', status: 'completed', producerReported: true, toolCall: { rootCallId, callId } }
      add('job/settled', { ...settlement, owner: 'other', detail: 'exit code: 99' })
      add('job/settled', { ...settlement, owner: 'own', detail: `exit code: ${exitCode}` })
      if (nested) add('tool/ptc-dispatch', { subCallId: callId, parentCallId: rootCallId,
        rootCallId, name: 'bash', isError: false, content })
      add('tool/result', { message: { source: { callId: rootCallId }, isError: false, content } })
      assert.equal(state.failure, null)
      assert.equal(state.proofs.length, 1)
      assert.equal(state.proofs[0].tool, 'bash')
      assert.equal(state.proofs[0].qualification, exitCode === 0 ? 'SUCCESS' : 'FAILED')
      assert.equal(state.proofs[0].ownOutcome, exitCode === 0 ? 'UNVERIFIED' : 'FAIL')
      assert.deepEqual(state.bashFailures, [])
    }
  }
})
test('intent with another session ID fails closed and no graph success is manufactured', () => {
  let state = initialState({ id: 'own' })
  state = applyEvent(state, { seq: 0, type: 'turn/start', data: { turn: 1 } })
  state = applyEvent(state, { seq: 1, type: INTENT, data: { version: 4, operationId: 'op_fixture', callId: 'call',
    rootCallId: 'call', turn: 1, sessionId: 'foreign', bindingDigest: '0'.repeat(64), claimDigest: '1'.repeat(64),
    operation: 'create', expectedGraphRevision: 0, candidateChecksum: '2'.repeat(64), clearedWork: [] } })
  assert.match(state.failure, /INTENT_SCOPE_REPLAY_OR_LIMIT/)
  assert.equal(state.intents.length, 0)
})
test('every own UNKNOWN root enters the independent ledger, regardless of administrative-looking name', () => {
  for (const name of ['update_goal', 'transaction_graph_external', 'transaction_graph_read']) {
    let state = initialState({ id: 'own' })
    state = applyEvent(state, { seq: 0, type: 'tool/call', data: { callId: 'root', name } })
    state = applyEvent(state, { seq: 1, type: 'tool/result', data: { message: { source: { callId: 'root' }, content: [{ type: 'text', text: '{"status":"UNKNOWN"}' }] } } })
    assert.equal(state.failure, null); assert.equal(state.uncertainties.length, 1)
    assert.equal(state.uncertainties[0].rootCallId, 'root')
  }
})

test('legacy Bash foreground failures and background acknowledgements do not qualify as completion proof', () => {
  for (const [text, qualification] of [['output\n[exit code: 7]', 'FAILED'],
    ['output\n[killed by signal: SIGTERM]', 'FAILED'], ['output\n[timed out after 50ms]', 'FAILED'],
    ['output\n[sandbox: file access denied under workspace-write mode]', 'FAILED'],
    ['started background job fixture', 'UNKNOWN'],
    ['output with an ordinary [exit code: 7] string', 'SUCCESS']]) {
    for (const nested of [false, true]) {
      let state = initialState({ id: 'own' })
      const add = (type, data) => { state = applyEvent(state, { seq: state.lastSeq + 1, type, data }) }
      const content = [{ type: 'text', text }]
      add('tool/call', { callId: 'root', name: nested ? 'run_code' : 'bash' })
      if (nested) add('tool/ptc-dispatch', { subCallId: 'child', parentCallId: 'root',
        rootCallId: 'root', name: 'bash', isError: false, content })
      add('tool/result', { message: { source: { callId: 'root' }, isError: false,
        content: nested ? [{ type: 'text', text: 'Program returned normally.' }] : content } })
      assert.equal(state.failure, null)
      assert.equal(state.proofs[0].qualification, qualification, text)
    }
  }
})
