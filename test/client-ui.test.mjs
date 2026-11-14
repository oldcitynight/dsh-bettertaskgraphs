import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { z } from 'zod'
import { createRemoteContribution } from '../remote.mjs'
import { branchLayout, graphPresentation } from '../view-model.mjs'

const graph = {
  revision: 4, title: 'Publish', active: { nodeId: 'inspect', recoveryRequired: true }, pending: null,
  nodes: [
    { id: 'group', label: 'Root', kind: 'container', parent: null, status: 'CONTAINER_INCOMPLETE' },
    { id: 'prepare', label: 'Prepare', kind: 'leaf', parent: 'group', status: 'COMPLETE', disposition: 'COMPLETED' },
    { id: 'check-group', label: 'Checks', kind: 'container', parent: 'group', status: 'CONTAINER_INCOMPLETE' },
    { id: 'inspect', label: 'Inspect', kind: 'leaf', parent: 'check-group', status: 'ACTIVE' },
    { id: 'ship', label: 'Ship', kind: 'leaf', parent: 'group', status: 'INACTIVE' },
    { id: 'escalate', label: 'Escalate', kind: 'leaf', parent: 'group', status: 'INCOMPLETE', disposition: 'FAILED' },
    { id: 'optional', label: 'Optional', kind: 'leaf', parent: 'group', status: 'SKIPPED', disposition: 'SKIPPED_NOT_RUN' },
  ],
  edges: [
    { from: 'prepare', to: 'inspect', kind: 'prerequisite' },
    { from: 'inspect', to: 'ship', kind: 'case', case: 'signed' },
    { from: 'inspect', to: 'escalate', kind: 'route', outcome: 'incomplete' },
  ],
  legalNext: [], skipChoices: [],
}

test('the shared RPC admits one strict, cancellable read and rejects private fields', () => {
  const contribution = createRemoteContribution(z)
  const [endpoint] = contribution.descriptors
  assert.equal(contribution.package, 'dsh-bettertaskgraphs')
  assert.equal(contribution.descriptors.length, 1)
  assert.equal(endpoint.service, 'transactionGraph')
  assert.equal(endpoint.namespace + '/' + endpoint.method, 'transactionGraphView/status')
  assert.equal(endpoint.cancellation.parameter, 'signal')
  assert.equal(endpoint.parameters[0].source, 'lookup')
  assert.equal(endpoint.parameters[0].wire, 'sessionId')
  assert.equal(endpoint.parameters[0].codec.create().parse('session-1'), 'session-1')
  assert.equal(endpoint.parameters[0].codec.create().safeParse({ sessionId: 'session-1', begin: 1 }).success, false)
  const schema = endpoint.result.create()
  assert.equal(schema.safeParse({ sessionId: 'session-1', status: 'ready', graph }).success, true)
  assert.equal(schema.safeParse({ sessionId: 'session-1', status: 'empty', graph: null }).success, true)
  assert.equal(schema.safeParse({ sessionId: 'session-1', status: 'ready', graph: null }).success, false)
  assert.equal(schema.safeParse({ sessionId: 'session-1', status: 'ready',
    graph: { ...graph, nodes: [{ ...graph.nodes[0], evidence: ['/private/file'] }, ...graph.nodes.slice(1)] } }).success, false)
  assert.equal(schema.safeParse({ sessionId: 'session-1', status: 'ready',
    graph: { ...graph, edges: [{ ...graph.edges[0], outcome: 'complete' }] } }).success, false)
})

test('nested groups preserve containment and list the direct entry conditions', () => {
  const view = graphPresentation(graph)
  assert.equal(view.active.id, 'inspect')
  assert.equal(view.selected.id, 'inspect')
  assert.deepEqual(view.children.get('check-group').map(node => node.id), ['inspect'])
  assert.deepEqual(view.conditions.map(node => node.id), ['prepare'])
  assert.deepEqual(view.progress, { total: 5, complete: 1, incomplete: 1, skipped: 1, inactive: 1, excluded: 0, ready: 0 })
})

test('the branch canvas ranks dependencies and distinguishes chosen, excluded and blocked lines', () => {
  const nodes = graph.nodes.map(node => {
    if (node.id === 'ship') return { ...node, branchState: 'NOT_SELECTED' }
    if (node.id === 'inspect') return { ...node, status: 'INCOMPLETE', disposition: 'FAILED',
      selectedBranch: { outcome: 'incomplete', targetId: 'escalate' } }
    if (node.id === 'optional') return { ...node, status: 'PENDING', disposition: undefined, blocked: true }
    return node
  })
  const edges = [...graph.edges,
    { from: 'prepare', to: 'optional', kind: 'prerequisite' },
    { from: 'escalate', to: 'optional', kind: 'prerequisite' }]
  const updated = { ...graph, nodes, edges }
  const layout = branchLayout(updated)
  assert.deepEqual(branchLayout(updated), layout)
  assert.deepEqual(layout.cards.map(card => [card.node.id, card.column]),
    [['prepare', 0], ['inspect', 1], ['ship', 2], ['escalate', 2], ['optional', 3]])
  assert.deepEqual(layout.wires.map(wire => wire.state),
    ['prerequisiteMet', 'branchExcluded', 'branchChosen', 'blocked'])
  assert.equal(layout.cards.find(card => card.node.id === 'optional').additionalPrerequisites, 1)
  assert.equal(layout.cards.find(card => card.node.id === 'inspect').group, 'Checks')
  assert.deepEqual(graphPresentation(updated, 'optional').conditions.map(node => [node.id, node.disposition]),
    [['prepare', 'COMPLETED'], ['escalate', 'FAILED']])
  const schema = createRemoteContribution(z).descriptors[0].result.create()
  assert.equal(schema.parse({ sessionId: 'session-1', status: 'ready', graph: updated }).graph.nodes.at(-1).blocked, true)
})

const prerequisite = (from, to) => ({ from, to, kind: 'prerequisite' })

test('a prerequisite already implied by the chain drops out of the map and entry list', () => {
  const chain = [prerequisite('prepare', 'inspect'), prerequisite('inspect', 'escalate'), prerequisite('escalate', 'optional')]
  const edges = [...chain, prerequisite('prepare', 'optional'), prerequisite('inspect', 'optional')]
  const updated = { ...graph, edges }
  const layout = branchLayout(updated)
  assert.deepEqual(layout.wires.map(wire => wire.edge), chain)
  assert.equal(layout.cards.find(card => card.node.id === 'optional').additionalPrerequisites, 0)
  assert.deepEqual(graphPresentation(updated, 'optional').conditions.map(node => node.id), ['escalate'])
  assert.equal(updated.edges.length, 5)
})

test('an intermediate branch gate or a container keeps the explicit prerequisite', () => {
  const gated = { ...graph, edges: [
    prerequisite('prepare', 'inspect'), prerequisite('inspect', 'optional'), prerequisite('prepare', 'optional'),
    { from: 'ship', to: 'inspect', kind: 'case', case: 'enabled' },
  ] }
  assert.deepEqual(graphPresentation(gated, 'optional').conditions.map(node => node.id), ['inspect', 'prepare'])
  const gatedLayout = branchLayout(gated)
  assert.equal(gatedLayout.cards.find(card => card.node.id === 'optional').additionalPrerequisites, 1)
  assert.ok(gatedLayout.wires.some(wire => wire.edge.kind === 'case'))

  const grouped = { ...graph, edges: [
    prerequisite('check-group', 'ship'), prerequisite('ship', 'optional'), prerequisite('check-group', 'optional'),
  ] }
  assert.deepEqual(graphPresentation(grouped, 'optional').conditions.map(node => node.id), ['ship', 'check-group'])
  assert.equal(branchLayout(grouped).cards.find(card => card.node.id === 'optional').additionalPrerequisites, 1)
})

test('branch markers cross the Web RPC and remove unselected work from progress', () => {
  const nodes = graph.nodes.map(node => {
    if (node.id === 'ship') return { ...node, branchState: 'NOT_SELECTED' }
    if (node.id === 'inspect') return { ...node, status: 'INCOMPLETE',
      selectedBranch: { outcome: 'incomplete', targetId: 'escalate' } }
    return node
  })
  const schema = createRemoteContribution(z).descriptors[0].result.create()
  const result = schema.parse({ sessionId: 'session-1', status: 'ready', graph: { ...graph, nodes, active: null } })
  const view = graphPresentation(result.graph)
  assert.equal(view.nodes.get('inspect').selectedBranch.targetId, 'escalate')
  assert.equal(view.nodes.get('ship').branchState, 'NOT_SELECTED')
  assert.equal(view.progress.total, 4)
  assert.equal(view.progress.excluded, 1)
})

test('selection falls back to the Host-ready leaf then the root and never infers readiness from a status', () => {
  const idle = { ...graph, active: null, legalNext: [{ id: 'ship', choice: 0 }] }
  assert.equal(graphPresentation(idle, 'missing').selected.id, 'ship')
  assert.equal(graphPresentation(idle, 'inspect').selected.id, 'inspect')
  const blocked = graphPresentation({ ...idle, pending: { operation: 'begin', qualification: 'UNKNOWN' }, legalNext: [] })
  assert.equal(blocked.selected.id, 'group')
  assert.equal(blocked.legal.size, 0)
})

test('generated bundle registers the graph in the existing session composer dock', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let plugin
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(row) {
      assert.equal(row.id, 'dsh-bettertaskgraphs')
      plugin = row.factory(name => ({ react: {}, zod: { z } })[name])
    } } },
  })
  let scope, endpoint, entry
  const callbacks = []
  const ctx = {
    effect(callback) { callbacks.push(callback) },
    locale: { register(namespace, locales) {
      assert.equal(namespace, 'projectTransactionGraph')
      assert.equal(locales.zh.title, '事务图')
      assert.equal(locales.en.title, 'Transaction graph')
    } },
    remote: {
      transactionGraphView: { status() { throw new Error('UI mount must not read before a session renders') } },
      async $mount(contribution) { endpoint = contribution.descriptors[0]; return () => {} },
    },
    inject(deps, callback) {
      scope = [...deps]
      callback(this)
    },
    slots: {
      inject(name, callback) { assert.equal(name, 'conversation.input.dock'); callback() },
      register(spec, component) { entry = spec; assert.equal(typeof component, 'function') },
    },
  }
  await plugin.apply(ctx)
  callbacks[0]()
  assert.deepEqual(scope, ['remote.transactionGraphView'])
  assert.equal(endpoint.namespace, 'transactionGraphView')
  assert.equal(entry.id, 'project-transaction-graph')
  assert.equal(entry.name, 'conversation.input.dock')
})
