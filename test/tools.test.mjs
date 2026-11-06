import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolDefinitions, TOOL_NAMES } from '../tools.mjs'

const execution = (callId = 'call-fixture') => ({ agent: { id: 'agent-fixture' }, callId, signal: new AbortController().signal })
const find = (tools, suffix) => tools.find(tool => tool.name.endsWith(suffix))
function connectedPort() {
  const staged = []
  return { staged,
    authorize: async exec => ({ agentId: exec.agent.id, sessionScope: 'fixture-scope', currentInitiatorVerified: true }),
    read: async () => ({ revision: 0, graph: null, goalReached: false }),
    stageMutation: async value => { staged.push(value); return { state: 'PENDING_HOST_COMMIT', operationId: value.operationId } },
  }
}
test('default port cannot access a real session, mutate state, or claim integration success', async () => {
  const tools = createToolDefinitions({ defineTool: value => value })
  await assert.rejects(find(tools, '_read').execute({}, execution()), error => error.code === 'DSH_INTEGRATION_NOT_RUN')
})
test('only read is classified read/protocol; no mutation bypasses normal permissions', () => {
  const tools = createToolDefinitions({ defineTool: value => value })
  assert.deepEqual(tools.map(tool => tool.name), [...TOOL_NAMES])
  assert.equal(find(tools, '_read').projectPlanCapability, 'read_or_protocol')
  assert.equal(tools.filter(tool => tool.name !== TOOL_NAMES[0]).some(tool => tool.projectPlanCapability !== undefined), false)
})
test('writes produce host-generated operation IDs and pending intents, never pretend committed completion', async () => {
  const port = connectedPort(), tools = createToolDefinitions({ defineTool: value => value, hostPort: port })
  const begin = find(tools, '_begin'), args = { expectedRevision: 7, choice: 2 }
  const result = await begin.execute(args, execution())
  assert.match(result.operationId, /^op_[a-f0-9]{64}$/)
  assert.equal(result.state, 'PENDING_HOST_COMMIT'); assert.equal(result.goalReached, false)
  assert.equal(port.staged.length, 1); assert.equal(port.staged[0].operation, 'begin')
  args.choice = 99; assert.equal(port.staged[0].arguments.choice, 2)
})
test('same scoped call maps to same anti-replay ID; another scope is distinct', async () => {
  const port = connectedPort(), tools = createToolDefinitions({ defineTool: value => value, hostPort: port })
  const begin = find(tools, '_begin'), args = { expectedRevision: 1, choice: 0 }
  const first = await begin.execute(args, execution()), repeat = await begin.execute(args, execution())
  assert.equal(first.operationId, repeat.operationId)
  port.authorize = async exec => ({ agentId: exec.agent.id, sessionScope: 'different-fixture', currentInitiatorVerified: true })
  assert.notEqual((await begin.execute(args, execution())).operationId, first.operationId)
})
test('model cannot supply operation/attempt/owner IDs, false authority is rejected', async () => {
  const port = connectedPort(), tools = createToolDefinitions({ defineTool: value => value, hostPort: port }), begin = find(tools, '_begin')
  await assert.rejects(begin.execute({ expectedRevision: 1, choice: 0, operationId: 'forged' }, execution()), error => error.code === 'UNEXPECTED_TOOL_ARGUMENT')
  port.authorize = async () => ({ agentId: 'other-agent', sessionScope: 'fixture-scope', currentInitiatorVerified: true })
  await assert.rejects(begin.execute({ expectedRevision: 1, choice: 0 }, execution()), error => error.code === 'HOST_OWNERSHIP_NOT_VERIFIED')
  assert.equal(port.staged.length, 0)
})
test('port may not report an immediate mutation commit; missing agent/aborted execution never reaches it', async () => {
  const port = connectedPort(), tools = createToolDefinitions({ defineTool: value => value, hostPort: port }), begin = find(tools, '_begin')
  port.stageMutation = async () => ({ state: 'COMPLETE' })
  await assert.rejects(begin.execute({ expectedRevision: 1, choice: 0 }, execution()), error => error.code === 'HOST_MUST_STAGE_NOT_PRETEND_COMMIT')
  await assert.rejects(begin.execute({ expectedRevision: 1, choice: 0 }, { callId: 'no-agent' }), error => error.code === 'REAL_AGENT_TOOL_EXECUTION_REQUIRED')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(begin.execute({ expectedRevision: 1, choice: 0 }, { ...execution(), signal: controller.signal }), error => error.name === 'AbortError')
})
