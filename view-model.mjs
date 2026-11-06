// SPDX-License-Identifier: GPL-3.0-only
// Only reduce a prerequisite that is already implied by a chain of leaf
// prerequisites. Entering a conditional task can change branch participation.
function chainEdges(graph) {
  const leaves = new Set(graph.nodes.filter(node => node.kind === 'leaf').map(node => node.id))
  const prerequisites = new Map()
  const conditional = new Set()
  for (const edge of graph.edges) {
    if (edge.kind !== 'prerequisite') {
      conditional.add(edge.to)
      continue
    }
    const sources = prerequisites.get(edge.to) ?? []
    sources.push(edge.from)
    prerequisites.set(edge.to, sources)
  }
  return graph.edges.filter(edge => {
    if (edge.kind !== 'prerequisite' || !leaves.has(edge.from)) return true
    const sources = prerequisites.get(edge.to)
    if (sources.length < 2) return true
    const pending = sources.filter(id => id !== edge.from)
    const seen = new Set()
    while (pending.length) {
      const id = pending.pop()
      if (id === edge.from) return false
      if (!leaves.has(id) || conditional.has(id) || seen.has(id)) continue
      seen.add(id)
      pending.push(...(prerequisites.get(id) ?? []))
    }
    return true
  })
}

// Host supplies legal choices. The browser only organizes them for display.
export function graphPresentation(graph, selectedId) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const children = new Map()
  for (const node of graph.nodes) {
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }
  const active = graph.active ? nodes.get(graph.active.nodeId) ?? null : null
  const legal = new Set(graph.legalNext.map(choice => choice.id))
  const selected = nodes.get(selectedId) ?? active ?? nodes.get(graph.legalNext[0]?.id) ?? children.get(null)?.[0] ?? null
  const conditionIds = new Set(chainEdges(graph).filter(edge => edge.to === selected?.id).map(edge => edge.from))
  const conditions = [...conditionIds].map(id => nodes.get(id)).filter(Boolean)
  const allLeaves = graph.nodes.filter(node => node.kind === 'leaf')
  const leaves = allLeaves.filter(node => node.branchState !== 'NOT_SELECTED')
  const count = status => leaves.filter(node => node.status === status).length
  return {
    nodes, children, active, legal, selected, conditions,
    progress: {
      total: leaves.length, complete: count('COMPLETE'), incomplete: count('INCOMPLETE'),
      skipped: count('SKIPPED'), inactive: count('INACTIVE'), excluded: allLeaves.length - leaves.length, ready: legal.size,
    },
  }
}

function branchEdgeState(edge, source, target) {
  if (source.branchState === 'NOT_SELECTED' || target.branchState === 'NOT_SELECTED') return 'branchExcluded'
  if (edge.kind === 'prerequisite') {
    if (source.status === 'COMPLETE') return 'prerequisiteMet'
    if (source.status === 'INCOMPLETE' || source.status === 'SKIPPED' || source.blocked) return 'blocked'
    return 'edgeWaiting'
  }
  const selected = source.selectedBranch
  if (selected?.targetId === edge.to && (edge.kind === 'route' ? selected.outcome === edge.outcome : selected.case === edge.case))
    return 'branchChosen'
  return selected || source.status === 'SKIPPED' ? 'branchExcluded' : 'edgeWaiting'
}

// Rank by explicit dependencies. Containers stay in the tree unless they
// participate in a dependency. A leaf still shows which container it belongs to.
export function branchLayout(graph) {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  const edges = chainEdges(graph).filter(edge => nodesById.has(edge.from) && nodesById.has(edge.to))
  const connected = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  const nodes = graph.nodes.filter(node => node.kind === 'leaf' || connected.has(node.id))
  const outgoing = new Map(nodes.map(node => [node.id, []]))
  const incoming = new Map(nodes.map(node => [node.id, []]))
  for (const edge of edges) {
    outgoing.get(edge.from).push(edge)
    incoming.get(edge.to).push(edge)
  }
  const incomingCount = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]))
  const rank = new Map(nodes.map(node => [node.id, 0]))
  const queue = nodes.filter(node => incomingCount.get(node.id) === 0).map(node => node.id)
  for (const id of queue) {
    for (const { to: target } of outgoing.get(id)) {
      rank.set(target, Math.max(rank.get(target), rank.get(id) + 1))
      const remaining = incomingCount.get(target) - 1
      incomingCount.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  const columns = Array.from({ length: 1 + Math.max(0, ...rank.values()) }, () => [])
  for (const node of nodes) columns[rank.get(node.id)].push(node)

  const padding = 26, cardWidth = 194, cardHeight = 84, columnGap = 104, rowGap = 26
  const rows = Math.max(1, ...columns.map(column => column.length))
  const bodyHeight = rows * (cardHeight + rowGap) - rowGap
  const cards = columns.flatMap((column, index) => column.map((node, row) => ({
    node,
    group: nodesById.get(node.parent)?.label,
    column: index,
    additionalPrerequisites: 0,
    x: padding + index * (cardWidth + columnGap),
    y: padding + (rows - column.length) * (cardHeight + rowGap) / 2 + row * (cardHeight + rowGap),
  })))
  const cardById = new Map(cards.map(card => [card.node.id, card]))
  const drawnEdges = new Set(edges.filter(edge => {
    const source = cardById.get(edge.from), target = cardById.get(edge.to)
    if (edge.kind !== 'prerequisite' || target.column === source.column + 1) return true
    // The entry list still shows independent prerequisites that skip a column.
    target.additionalPrerequisites += 1
    return false
  }))
  for (const [id, group] of outgoing)
    outgoing.set(id, group.filter(edge => drawnEdges.has(edge)).sort((a, b) => cardById.get(a.to).y - cardById.get(b.to).y))
  for (const [id, group] of incoming)
    incoming.set(id, group.filter(edge => drawnEdges.has(edge)).sort((a, b) => cardById.get(a.from).y - cardById.get(b.from).y))
  const portOffset = (group, edge) => (group.indexOf(edge) - (group.length - 1) / 2) * Math.min(13, 52 / group.length)
  const bendOffset = (group, edge) => 12 + 28 * (group.indexOf(edge) + 1) / (group.length + 1)
  const pairKey = edge => JSON.stringify([edge.from, edge.to])
  const parallel = new Map()
  for (const edge of drawnEdges) {
    const pair = pairKey(edge)
    parallel.set(pair, (parallel.get(pair) ?? 0) + 1)
  }
  let laneCount = 0
  const wires = [...drawnEdges].map(edge => {
    const from = cardById.get(edge.from), to = cardById.get(edge.to)
    const exits = outgoing.get(edge.from), entries = incoming.get(edge.to)
    const startX = from.x + cardWidth, endX = to.x - 2
    const startY = from.y + cardHeight / 2 + portOffset(exits, edge)
    const endY = to.y + cardHeight / 2 + portOffset(entries, edge)
    const state = branchEdgeState(edge, from.node, to.node)
    const wire = { edge, from: from.node, to: to.node, state,
      key: JSON.stringify([edge.from, edge.to, edge.kind, edge.outcome ?? edge.case]),
      showLabel: edge.kind !== 'prerequisite' && (parallel.get(pairKey(edge)) === 1 || state === 'branchChosen') }
    if (to.column - from.column > 1) {
      // Route rank-skipping edges below the cards so they do not cross a task.
      const laneY = padding + bodyHeight + 22 + laneCount++ * 16
      const exitX = startX + bendOffset(exits, edge), entryX = endX - bendOffset(entries, edge)
      return { ...wire, path: `M ${startX} ${startY} H ${exitX} V ${laneY} H ${entryX} V ${endY} H ${endX}`,
        labelX: (startX + endX) / 2, labelY: laneY - 5 }
    }
    return { ...wire, path: `M ${startX} ${startY} C ${startX + 40} ${startY}, ${endX - 40} ${endY}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2, labelY: (startY + endY) / 2 - 7 }
  })
  return {
    cards, wires, cardWidth, cardHeight,
    width: columns.length * (cardWidth + columnGap) - columnGap + 2 * padding,
    height: bodyHeight + 2 * padding + laneCount * 16 + (laneCount ? 12 : 0),
  }
}
