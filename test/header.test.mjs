import test from 'node:test'
import assert from 'node:assert/strict'
import { sameStoredSessionHeader } from '../host.mjs'
const header = { version: 4, id: 'explicit-synthetic-session', createdAt: 10, cwd: '/private/synthetic', isSeeded: false }
test('official fresh absent delegationDepth equals JSONL materialized depth zero in either direction', () => {
  assert.equal(sameStoredSessionHeader(header, { ...header, delegationDepth: 0 }), true)
  assert.equal(sameStoredSessionHeader({ ...header, delegationDepth: 0 }, header), true)
  assert.equal(sameStoredSessionHeader({ ...header, delegationDepth: 3 }, { ...header, delegationDepth: 3 }), true)
})
test('depth and every other full header field remain exact; malformed values are not a header', () => {
  for (const patch of [{ delegationDepth: 1 }, { id: 'wrong' }, { createdAt: 11 }, { cwd: '/wrong' }, { version: 3 }, { isSeeded: true }, { parentSession: 'other' }, { origin: 'subagent' }, { agentPreset: 'other' }])
    assert.equal(sameStoredSessionHeader(header, { ...header, ...patch }), false)
  assert.equal(sameStoredSessionHeader(header, { ...header, unexpected: 'extra' }), false)
  assert.equal(sameStoredSessionHeader(null, null), false)
  assert.equal(sameStoredSessionHeader([], []), false)
})
