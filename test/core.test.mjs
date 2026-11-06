import test from 'node:test'
import assert from 'node:assert/strict'
import { TransactionGraph, GraphError, LIMITS, normalizePlan, documentOf, validateDocument, digest, copy } from '../core.mjs'
import { MemoryGraphStore } from '../store.mjs'

const ids = () => { let n = 0; return prefix => `${prefix}_${++n}` }
const refs = () => [{ kind: 'tool_result', ref: 'session:fixture/event:trusted-location-only' }]
const definition = (edges = []) => ({ title: 'Fixture graph', nodes: [
  { key: 'root', kind: 'container', label: 'Root' },
  { key: 'a', kind: 'leaf', label: 'A', parent: 'root' },
  { key: 'b', kind: 'leaf', label: 'B', parent: 'root' },
  { key: 'c', kind: 'leaf', label: 'C', parent: 'root' },
], edges })
function fixture(plan = definition(), options = {}) {
  const id = ids(), store = new MemoryGraphStore(), graph = new TransactionGraph(store, { id, ...options })
  graph.create({ operationId: 'create', definition: plan })
  return { graph, store, id }
}
function choose(graph, key) {
  const view = graph.read(), id = view.nodes.find(node => node.key === key).id
  return view.legalNext.find(row => row.id === id)?.choice
}
function begin(graph, key, operationId = 'begin') {
  return graph.begin({ expectedRevision: graph.read().revision, operationId, choice: choose(graph, key) })
}
function finish(graph, outcome = 'complete', operationId = 'finish', extra = {}) {
  return graph.finish({ expectedRevision: graph.read().revision, operationId, outcome, evidence: refs(), note: 'Explicit fixture outcome', ...extra })
}
function code(expected) { return error => error instanceof GraphError && error.code === expected }
function rechain(events) {
  let previousHash = null
  return events.map(raw => { const value = { ...raw, previousHash }; delete value.hash; value.hash = digest(value); previousHash = value.hash; return value })
}

test('IDs and legal choice indices are generated, read does not establish Goal success', () => {
  const { graph, store } = fixture()
  const view = graph.read()
  assert.equal(view.legalNext.length, 3)
  assert.deepEqual(view.legalNext.map(row => row.choice), [0, 1, 2])
  assert.equal(view.goalReached, false)
  assert.notEqual(view.nodes.find(node => node.key === 'a').id, 'a')
  assert.equal(store.read().events.length, 1)
})
test('one active leaf, containers are not begin choices, cannot create a second plan', () => {
  const { graph } = fixture()
  assert.equal(graph.read().legalNext.some(row => row.label === 'Root'), false)
  begin(graph, 'a')
  assert.equal(graph.read().legalNext.length, 0)
  assert.throws(() => graph.begin({ expectedRevision: 2, operationId: 'begin_b', choice: 0 }), code('ONE_ACTIVE_LEAF_ONLY'))
  assert.throws(() => graph.create({ expectedRevision: 2, operationId: 'replace', definition: definition() }), code('PLAN_IMMUTABLE_CREATE_ONCE'))
})
test('CAS rejects stale revision and begin/finish operation replay without changing history', () => {
  const { graph, store } = fixture()
  assert.throws(() => graph.begin({ expectedRevision: 0, operationId: 'old', choice: 0 }), code('CAS_CONFLICT'))
  begin(graph, 'a', 'begin_a')
  assert.throws(() => graph.begin({ expectedRevision: 2, operationId: 'begin_a', choice: 0 }), code('OPERATION_REPLAY'))
  finish(graph, 'complete', 'finish_a')
  assert.throws(() => graph.finish({ expectedRevision: 3, operationId: 'finish_a', outcome: 'complete', note: 'Replay' }), code('OPERATION_REPLAY'))
  assert.equal(store.read().events.length, 3)
})
test('complete and incomplete routes activate only their branch; inactive prerequisite is not completed', () => {
  const { graph } = fixture(definition([
    { kind: 'route', from: 'a', to: 'b', outcome: 'complete' },
    { kind: 'route', from: 'a', to: 'c', outcome: 'incomplete' },
    { kind: 'prerequisite', from: 'b', to: 'c' },
  ]))
  assert.deepEqual(graph.read().legalNext.map(row => row.label), ['A'])
  begin(graph, 'a'); finish(graph, 'incomplete')
  const view = graph.read()
  assert.equal(view.nodes.find(row => row.key === 'b').status, 'INACTIVE')
  assert.equal(view.nodes.find(row => row.key === 'c').status, 'PENDING')
  assert.equal(view.legalNext.length, 0)
  assert.equal(view.nodes.find(row => row.key === 'root').allChildrenComplete, false)
})
test('completed prerequisite unblocks but incomplete prerequisite never does', () => {
  const { graph } = fixture(definition([{ kind: 'prerequisite', from: 'a', to: 'b' }]))
  assert.equal(choose(graph, 'b'), undefined)
  begin(graph, 'a'); finish(graph)
  assert.equal(typeof choose(graph, 'b'), 'number')
  const other = fixture(definition([{ kind: 'prerequisite', from: 'a', to: 'b' }])).graph
  begin(other, 'a'); finish(other, 'incomplete')
  assert.equal(choose(other, 'b'), undefined)
})
test('skip is explicitly pending-only, neither satisfies prerequisite nor fires a route', () => {
  const { graph } = fixture(definition([
    { kind: 'prerequisite', from: 'a', to: 'b' },
    { kind: 'route', from: 'a', to: 'c', outcome: 'incomplete' },
  ]))
  const a = graph.read().skipChoices.find(row => row.label === 'A').choice
  graph.skip({ expectedRevision: 1, operationId: 'skip_a', choice: a, note: 'Explicitly excluded from this fixture' })
  assert.equal(choose(graph, 'b'), undefined)
  assert.equal(graph.read().nodes.find(row => row.key === 'c').status, 'INACTIVE')
  assert.equal(graph.read().nodes.find(row => row.key === 'a').status, 'SKIPPED')
})
test('complete requires a bounded traceable ref but does not verify it or mark Goal reached', () => {
  const { graph } = fixture()
  begin(graph, 'a')
  assert.throws(() => finish(graph, 'complete', 'no_refs', { evidence: [] }), code('COMPLETE_REQUIRES_TRACEABLE_REFERENCE'))
  const view = finish(graph)
  assert.equal(view.nodes.find(row => row.key === 'a').acceptance, 'UNVERIFIED_REFERENCE')
  assert.equal(view.goalReached, false)
})
test('parent container complete only when all recursive children are actually complete', () => {
  const plan = definition()
  plan.nodes.push({ key: 'group', kind: 'container', label: 'Group', parent: 'root' })
  plan.nodes.find(row => row.key === 'b').parent = 'group'
  const { graph } = fixture(plan)
  begin(graph, 'b', 'b1'); finish(graph, 'complete', 'b2')
  assert.equal(graph.read().nodes.find(row => row.key === 'group').allChildrenComplete, true)
  assert.equal(graph.read().nodes.find(row => row.key === 'root').allChildrenComplete, false)
  begin(graph, 'a', 'a1'); finish(graph, 'complete', 'a2')
  begin(graph, 'c', 'c1'); finish(graph, 'complete', 'c2')
  assert.equal(graph.read().nodes.find(row => row.key === 'root').allChildrenComplete, true)
  assert.equal(graph.read().goalReached, false)
})
test('container releases its dependent after nested selected paths and prerequisite continuations finish', () => {
  const plan = definition([
    { kind: 'route', from: 'a', to: 'b', outcome: 'complete' },
    { kind: 'route', from: 'a', to: 'c', outcome: 'incomplete' },
    { kind: 'route', from: 'b', to: 'd', outcome: 'complete' },
    { kind: 'route', from: 'b', to: 'e', outcome: 'incomplete' },
    { kind: 'prerequisite', from: 'd', to: 'd_tail' },
    { kind: 'prerequisite', from: 'c', to: 'c_tail' },
    { kind: 'prerequisite', from: 'group', to: 'after' },
  ])
  for (const node of plan.nodes.slice(1)) node.parent = 'group'
  plan.nodes.push(
    { key: 'group', kind: 'container', label: 'Group', parent: 'root' },
    { key: 'nested', kind: 'container', label: 'Nested', parent: 'group' },
    { key: 'd', kind: 'leaf', label: 'D', parent: 'nested' },
    { key: 'e', kind: 'leaf', label: 'E', parent: 'nested' },
    { key: 'd_tail', kind: 'leaf', label: 'D tail', parent: 'nested' },
    { key: 'c_tail', kind: 'leaf', label: 'C tail', parent: 'group' },
    { key: 'after', kind: 'leaf', label: 'After', parent: 'root' },
  )
  const { graph, store, id } = fixture(plan)
  const row = key => graph.read().nodes.find(node => node.key === key)
  assert.equal(row('c_tail').branchState, 'WAITING')
  begin(graph, 'a', 'begin_a'); finish(graph, 'complete', 'finish_a')
  assert.deepEqual(row('a').selectedBranch, { outcome: 'complete', targetId: row('b').id })
  assert.equal(row('c').branchState, 'NOT_SELECTED')
  assert.equal(row('c_tail').branchState, 'NOT_SELECTED')
  assert.equal(row('d').branchState, 'WAITING')
  assert.equal(graph.read().skipChoices.some(choice => choice.id === row('c_tail').id), false)
  begin(graph, 'b', 'begin_b'); finish(graph, 'complete', 'finish_b')
  assert.equal(row('e').branchState, 'NOT_SELECTED')
  assert.equal(row('d_tail').branchState, 'SELECTED')
  begin(graph, 'd', 'begin_d'); finish(graph, 'complete', 'finish_d')
  assert.equal(choose(graph, 'after'), undefined)
  begin(graph, 'd_tail', 'begin_tail'); finish(graph, 'complete', 'finish_tail')
  assert.equal(row('nested').status, 'COMPLETE')
  assert.equal(row('group').status, 'COMPLETE')
  assert.equal(choose(graph, 'after'), 0)
  const saved = store.read()
  assert.equal(saved.state.leaves[row('c').id].status, 'INACTIVE')
  assert.equal(saved.state.leaves[row('c_tail').id].status, 'PENDING')
  assert.deepEqual(new TransactionGraph(store, { id }).read(), graph.read())
  assert.deepEqual(store.read(), saved)
  begin(graph, 'after', 'begin_after'); finish(graph, 'complete', 'finish_after')
  assert.equal(row('root').status, 'COMPLETE')
})
test('an in-container recovery chain closes the group while preserving each failed leaf', () => {
  const plan = definition([
    { kind: 'route', from: 'a', to: 'b', outcome: 'incomplete' },
    { kind: 'route', from: 'a', to: 'c', outcome: 'complete' },
    { kind: 'route', from: 'b', to: 'recover', outcome: 'incomplete' },
    { kind: 'prerequisite', from: 'group', to: 'after' },
    { kind: 'prerequisite', from: 'a', to: 'requires_a' },
  ])
  for (const node of plan.nodes.slice(1)) node.parent = 'group'
  plan.nodes.push(
    { key: 'group', kind: 'container', label: 'Group', parent: 'root' },
    { key: 'recover', kind: 'leaf', label: 'Recover', parent: 'group' },
    { key: 'after', kind: 'leaf', label: 'After', parent: 'root' },
    { key: 'requires_a', kind: 'leaf', label: 'Requires A', parent: 'root' },
  )
  const { graph, store, id } = fixture(plan)
  begin(graph, 'a', 'begin_a'); finish(graph, 'incomplete', 'finish_a', { disposition: 'FAILED' })
  begin(graph, 'b', 'begin_b'); finish(graph, 'incomplete', 'finish_b')
  assert.equal(choose(graph, 'after'), undefined)
  const failedRecovery = new TransactionGraph(new MemoryGraphStore(store.read()), { id })
  begin(failedRecovery, 'recover'); finish(failedRecovery, 'incomplete')
  assert.equal(choose(failedRecovery, 'after'), undefined)
  begin(graph, 'recover', 'begin_recovery'); finish(graph, 'complete', 'finish_recovery')
  const view = graph.read(), row = key => view.nodes.find(node => node.key === key)
  assert.equal(row('group').status, 'COMPLETE')
  assert.equal(row('a').status, 'INCOMPLETE')
  assert.equal(row('a').disposition, 'FAILED')
  assert.equal(row('b').status, 'INCOMPLETE')
  assert.equal(row('c').branchState, 'NOT_SELECTED')
  assert.equal(choose(graph, 'after'), 0)
  assert.equal(choose(graph, 'requires_a'), undefined)
})
test('a selected continuation remains blocked by an excluded prerequisite', () => {
  const plan = definition([
    { kind: 'route', from: 'a', to: 'b', outcome: 'complete' },
    { kind: 'route', from: 'a', to: 'c', outcome: 'incomplete' },
    { kind: 'prerequisite', from: 'b', to: 'join' },
    { kind: 'prerequisite', from: 'c', to: 'join' },
  ])
  plan.nodes.push({ key: 'join', kind: 'leaf', label: 'Join', parent: 'root' })
  const { graph } = fixture(plan)
  begin(graph, 'a', 'begin_a'); finish(graph, 'complete', 'finish_a')
  begin(graph, 'b', 'begin_b'); finish(graph, 'complete', 'finish_b')
  const view = graph.read(), row = key => view.nodes.find(node => node.key === key)
  assert.equal(row('join').branchState, 'SELECTED')
  assert.deepEqual(view.pendingButBlocked.find(node => node.id === row('join').id).unmetPrerequisites, [row('c').id])
  assert.equal(row('root').status, 'CONTAINER_INCOMPLETE')
})
test('a shared branch target stays waiting while another selector can activate it', () => {
  const { graph } = fixture(definition([
    { kind: 'route', from: 'a', to: 'b', outcome: 'complete' },
    { kind: 'route', from: 'c', to: 'b', outcome: 'complete' },
  ]))
  begin(graph, 'a', 'begin_a'); finish(graph, 'incomplete', 'finish_a')
  assert.equal(graph.read().nodes.find(node => node.key === 'b').branchState, 'WAITING')
  begin(graph, 'c', 'begin_c'); finish(graph, 'complete', 'finish_c')
  assert.equal(graph.read().nodes.find(node => node.key === 'b').branchState, 'SELECTED')
  assert.equal(choose(graph, 'b'), 0)
})
test('restart preserves ACTIVE and defaults to refusing automatic rerun/reconciliation', async () => {
  const { graph, store, id } = fixture(); begin(graph, 'a')
  const restarted = new TransactionGraph(store, { id })
  assert.equal(restarted.read().active.recoveryRequired, true)
  assert.throws(() => restarted.begin({ expectedRevision: 2, operationId: 'restart_begin', choice: 0 }), code('RECOVERY_REQUIRED'))
  assert.throws(() => finish(restarted), code('RECOVERY_REQUIRED'))
  await assert.rejects(restarted.reconcile({ expectedRevision: 2, operationId: 'reconcile', outcome: 'complete', evidence: refs(), note: 'Not attested' }), code('HOST_RECOVERY_ATTESTATION_REQUIRED'))
  assert.equal(store.read().revision, 2)
})
test('explicit recovery attests exact outcome/ref/case before CAS; does not rerun begin', async () => {
  const { graph, store, id } = fixture(); begin(graph, 'a')
  let attestation
  const restarted = new TransactionGraph(store, { id, verifyRecovery: async value => { attestation = value; return true } })
  const view = await restarted.reconcile({ expectedRevision: 2, operationId: 'recover', outcome: 'incomplete', evidence: refs(), note: 'External operator confirmed interrupted transaction' })
  assert.equal(attestation.selectedCase, null)
  assert.equal(attestation.outcome, 'incomplete')
  assert.equal(view.active, null)
  assert.equal(view.nodes.find(row => row.key === 'a').status, 'INCOMPLETE')
  assert.deepEqual(store.read().events.map(event => event.type), ['CREATED', 'BEGUN', 'RECONCILED'])
})
test('async recovery cannot overwrite concurrent normal finish or absorb mutated caller refs', async () => {
  const { graph, store, id } = fixture(); begin(graph, 'a')
  let release
  const restarted = new TransactionGraph(store, { id, verifyRecovery: () => new Promise(resolve => { release = resolve }) })
  const evidence = refs()
  const pending = restarted.reconcile({ expectedRevision: 2, operationId: 'recover', outcome: 'complete', evidence, note: 'Await verification' })
  evidence[0].ref = 'mutated-by-caller'
  finish(graph, 'complete', 'normal_finish')
  release(true)
  await assert.rejects(pending, code('CAS_CONFLICT'))
  assert.equal(store.read().events.at(-1).operationId, 'normal_finish')
})
test('switch is off by default, requires explicit one of at most eight declared cases', () => {
  const plan = definition([{ kind: 'case', from: 'a', to: 'b', case: 'yes' }, { kind: 'case', from: 'a', to: 'c', case: 'no' }])
  plan.nodes.find(row => row.key === 'a').switchCases = ['yes', 'no']
  assert.throws(() => fixture(plan), code('SWITCH_DISABLED_OR_LIMIT'))
  const { graph } = fixture(plan, { enableSwitch: true })
  begin(graph, 'a')
  assert.deepEqual(graph.read().active.caseChoices.map(row => row.label), ['yes', 'no'])
  assert.throws(() => finish(graph), code('EXPLICIT_SWITCH_CASE_REQUIRED'))
  finish(graph, 'complete', 'case_yes', { caseIndex: 0 })
  assert.equal(choose(graph, 'b'), 0)
  const view = graph.read(), row = key => view.nodes.find(node => node.key === key)
  assert.deepEqual(row('a').selectedBranch, { outcome: 'complete', case: 'yes', targetId: row('b').id })
  assert.equal(row('c').branchState, 'NOT_SELECTED')
  begin(graph, 'b', 'begin_b'); finish(graph, 'complete', 'finish_b')
  assert.equal(graph.read().nodes.find(node => node.key === 'root').status, 'COMPLETE')
  plan.nodes.find(row => row.key === 'a').switchCases = Array.from({ length: 9 }, (_, i) => 'case' + i)
  assert.throws(() => fixture(plan, { enableSwitch: true }), code('SWITCH_DISABLED_OR_LIMIT'))
})
test('containment, prerequisite and conditional route cycles are rejected including mixed container completion cycle', () => {
  const containment = definition(); containment.nodes[1].kind = 'container'; containment.nodes[1].parent = 'b'; containment.nodes[2].kind = 'container'; containment.nodes[2].parent = 'a'
  assert.throws(() => fixture(containment), code('CONTAINMENT_CYCLE'))
  for (const kind of ['prerequisite', 'route']) {
    const edge = (from, to) => ({ kind, from, to, ...(kind === 'route' ? { outcome: 'complete' } : {}) })
    assert.throws(() => fixture(definition([edge('a', 'b'), edge('b', 'a')])), code('PREREQUISITE_ROUTE_OR_COMPLETION_CYCLE'))
  }
  const mixed = definition([{ kind: 'prerequisite', from: 'group', to: 'b' }, { kind: 'route', from: 'b', to: 'a', outcome: 'complete' }])
  mixed.nodes.push({ key: 'group', kind: 'container', label: 'Group', parent: 'root' }); mixed.nodes[1].parent = 'group'
  assert.throws(() => fixture(mixed), code('PREREQUISITE_ROUTE_OR_COMPLETION_CYCLE'))
})
test('illegal edges, duplicates, same-source incomplete prerequisite and empty container rejected', () => {
  assert.throws(() => fixture(definition([{ kind: 'route', from: 'a', to: 'root', outcome: 'complete' }])), code('ILLEGAL_EDGE_KIND_OR_TARGET'))
  assert.throws(() => fixture(definition([{ kind: 'route', from: 'root', to: 'a', outcome: 'complete' }])), code('ROUTE_SOURCE_MUST_BE_LEAF'))
  assert.throws(() => fixture(definition([{ kind: 'route', from: 'a', to: 'b', outcome: 'incomplete' }, { kind: 'prerequisite', from: 'a', to: 'b' }])), code('INCOMPLETE_ROUTE_REQUIRES_SAME_COMPLETE_SOURCE'))
  const empty = definition(); empty.nodes.push({ key: 'empty', kind: 'container', label: 'Empty', parent: 'root' })
  assert.throws(() => fixture(empty), code('EMPTY_CONTAINER'))
  const duplicate = { kind: 'prerequisite', from: 'a', to: 'b' }
  assert.throws(() => fixture(definition([duplicate, duplicate])), code('DUPLICATE_EDGE'))
})
test('128 nodes, total512 edges and depth16 are program bounds', () => {
  const many = definition(); many.nodes = [many.nodes[0], ...Array.from({ length: 128 }, (_, i) => ({ key: 'leaf' + i, kind: 'leaf', label: 'Leaf', parent: 'root' }))]
  assert.throws(() => fixture(many), code('NODE_LIMIT'))
  const depth = definition(); depth.nodes = [depth.nodes[0]]
  for (let i = 1; i < 17; i++) depth.nodes.push({ key: 'node' + i, kind: i === 16 ? 'leaf' : 'container', label: 'Level', parent: i === 1 ? 'root' : 'node' + (i - 1) })
  assert.throws(() => fixture(depth), code('DEPTH_LIMIT'))
  const edges = definition(); edges.nodes = [edges.nodes[0], ...Array.from({ length: 40 }, (_, i) => ({ key: 'leaf' + i, kind: 'leaf', label: 'Leaf', parent: 'root' }))]; edges.edges = []
  for (let i = 0; i < 40 && edges.edges.length < 500; i++) for (let j = i + 1; j < 40 && edges.edges.length < 500; j++) edges.edges.push({ kind: 'prerequisite', from: 'leaf' + i, to: 'leaf' + j })
  assert.throws(() => fixture(edges), code('TOTAL_EDGE_LIMIT'))
  assert.equal(LIMITS.nodes, 128); assert.equal(LIMITS.edges, 512); assert.equal(LIMITS.depth, 16)
})
test('snapshot tampering is rejected even if its outer checksum is recomputed', () => {
  const { store } = fixture(); const document = store.read()
  document.state.leaves[Object.keys(document.state.leaves)[0]].status = 'COMPLETE'
  const body = { ...document }; delete body.checksum; document.checksum = digest(body)
  assert.throws(() => validateDocument(document), code('SNAPSHOT_REPLAY_MISMATCH'))
})
test('CAS cannot rewrite a valid rehashed earlier plan/history', () => {
  const { graph, store } = fixture(); const original = store.read()
  begin(graph, 'a'); const events = store.read().events
  events[0].data.plan.title = 'Rewritten immutable earlier plan'
  const rewritten = documentOf(rechain(events)), fresh = new MemoryGraphStore(original)
  assert.throws(() => fresh.compareAndSwap(1, () => rewritten), code('HISTORY_IMMUTABLE'))
})
test('duplicate generated IDs and model-provided durable ID fields are rejected', () => {
  assert.throws(() => normalizePlan(definition(), { id: () => 'same_id' }), code('INVALID_GENERATED_ID'))
  const plan = definition(); plan.nodes[1].id = 'model_supplied'
  assert.throws(() => normalizePlan(plan), code('UNKNOWN_FIELD'))
})
