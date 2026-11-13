// SPDX-License-Identifier: GPL-3.0-only
import { GraphError } from './core.mjs'

export const EXTENSION_CONTRACT = 'dsh-taskgraph-session-extension-v1'

/** Optional host extensions may suppress the classic interface per session.
 * Policy, interaction and extension data belong to the registering plugin.
 * With no provider, the original classic interface is unchanged.
 */
export class SessionPolicies {
  constructor() { this.providers = new Map(); this.closed = false }
  register({ id, allowClassic }) {
    if (this.closed || typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(id)
        || typeof allowClassic !== 'function' || this.providers.has(id)) throw new GraphError('SESSION_EXTENSION_CONTRACT_REQUIRED')
    const entry = { allowClassic }; this.providers.set(id, entry)
    return () => { if (this.providers.get(id) === entry) this.providers.delete(id) }
  }
  allowClassic(agent) {
    if (this.closed) return false
    for (const provider of this.providers.values()) if (provider.allowClassic(agent) !== true) return false
    return true
  }
  close() { this.closed = true; this.providers.clear() }
}
