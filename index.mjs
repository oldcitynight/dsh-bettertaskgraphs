// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createToolDefinitions } from './tools.mjs'
import { DshTransactionHost } from './host.mjs'
import { projection, KEY } from './projection.mjs'
import { createRemoteContribution } from './remote.mjs'

export const name = 'dsh-bettertaskgraphs'
let bindSessionResource
Remote({ resources: { session: ({ sessionId }) => sessionId } })(undefined, {
  kind: 'method', name: 'status', addInitializer: callback => { bindSessionResource = callback },
})
const guidance = 'For work the user asks to track in a transaction graph, read the program-generated revision and choices before creating or resuming it. One leaf may be active. Begin must commit before work starts. Pending or UNKNOWN work blocks finish and dependent work. Never replay blindly. Complete requires a qualified successful tool result after begin. Incomplete requires known failure, confirmed non-execution, or an unsatisfied outcome. Wait for the enclosing tool call to finish and read the committed state before continuing. Containers aggregate. Transaction completion does not complete Goal.'

export default class TransactionGraphPlugin extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'workingDirectory', 'tools', 'systemPrompt']
  constructor(ctx, config = {}) {
    super(ctx, 'transactionGraph', { namespace: 'transactionGraphView' })
    bindSessionResource.call(this)
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || Object.keys(config).some(key => !['projectRoot', 'storageRelative', 'enableSwitch'].includes(key)))
      throw new Error('Invalid transaction graph configuration')
    this.host = new DshTransactionHost(ctx, { ...config, appendPluginRecord })
    ctx.sessionProjections.register(projection)
    for (const definition of createToolDefinitions({ defineTool, hostPort: this.host })) {
      this.host.definitions.set(definition.name, definition)
      ctx.tools.register(definition)
    }
    ctx.systemPrompt.section({ name: 'project:transaction-graph', order: 46,
      text: ({ agent }) => this.host.inProject(agent?.session) ? guidance : '' })
    ctx.systemPrompt.context({ name: 'project:transaction-graph-state', order: 46, required: true, interpolate: false,
      text: ({ agent }) => this.host.inProject(agent?.session) ? this.host.context(agent) : '' })
    ctx.inject(['typert', 'sessionController'], remoteCtx => {
      const typert = remoteCtx.typert
      if (typert.resources.get('session')?.field !== 'sessionId') throw new Error('Transaction graph requires the native Session RPC resource')
      const contribution = createRemoteContribution(z)
      remoteCtx.effect(() => typert.register({ package: contribution.package, face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] }, invocations: contribution.descriptors }))
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.agent) return next()
      const running = this.host.running.get(exec.agent) ?? new Set()
      running.add(exec); this.host.running.set(exec.agent, running)
      try { return await next() } finally { running.delete(exec) }
    })
    ctx.on('session/event', (session, event) => {
      if ((event.type === 'tool/result' || event.type === 'turn/end')
          && ctx.sessionProjections.stateOf(session, KEY)?.intents.length) {
        // Appending during publication is forbidden by Session; defer the
        // durability barrier and journal CAS until publication has unwound.
        queueMicrotask(() => { if (!this.host.closed) this.host.schedule(session) })
      }
    })
    ctx.effect(() => () => this.host.close())
  }
  async status({ sessionId }, signal) {
    signal?.throwIfAborted()
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new RemoteError('session/not-found', 'Session controller unavailable', { sessionId })
    const result = await controller.resolveAgent(sessionId)
    if (result.error) throw result.error
    signal?.throwIfAborted()
    return this.host.snapshot(result.agent.session)
  }
  registerRecoveryVerifier(adapter) { return this.host.registerRecoveryVerifier(adapter) }
  recoverInterrupted(agent, request) { return this.host.recoverInterrupted(agent, request) }
}
