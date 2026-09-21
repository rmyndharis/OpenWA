import type { WorkflowField, WorkflowGraphDefinition, WorkflowGraphEdge, WorkflowGraphNode } from '../services/api';

const edgeId = () => `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export function createLinearWorkflowGraph(fields: WorkflowField[]): WorkflowGraphDefinition {
  const nodes: WorkflowGraphNode[] = [
    { id: 'flow_start', type: 'start', position: { x: 0, y: 80 }, data: { label: 'Início' } },
    ...fields.map((field, index) => ({
      id: `question:${field.id}`,
      type: 'question' as const,
      position: { x: (index + 1) * 260, y: 80 },
      data: { fieldId: field.id, label: field.label },
    })),
    {
      id: 'flow_review',
      type: 'review',
      position: { x: (fields.length + 1) * 260, y: 80 },
      data: { label: 'Revisar e salvar' },
    },
  ];
  return {
    version: 1,
    startNodeId: 'flow_start',
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({
      id: `edge:${node.id}:${nodes[index + 1].id}`,
      source: node.id,
      target: nodes[index + 1].id,
    })),
  };
}

export function reconcileWorkflowGraph(
  graph: WorkflowGraphDefinition | undefined,
  fields: WorkflowField[],
): WorkflowGraphDefinition {
  if (!graph?.nodes?.length || !graph.edges || graph.version !== 1) return createLinearWorkflowGraph(fields);
  let nodes = graph.nodes.map(node => ({ ...node, data: { ...node.data }, position: { ...node.position } }));
  let edges: WorkflowGraphEdge[] = graph.edges.map(edge => ({
    ...edge,
    ...(edge.condition ? { condition: { ...edge.condition } } : {}),
  }));
  const validFieldIds = new Set(fields.map(field => field.id));
  for (const removed of nodes.filter(node => node.type === 'question' && !validFieldIds.has(node.data.fieldId ?? ''))) {
    const incoming = edges.filter(edge => edge.target === removed.id);
    const outgoing = edges.filter(edge => edge.source === removed.id);
    edges = edges.filter(edge => edge.source !== removed.id && edge.target !== removed.id);
    for (const before of incoming) {
      for (const after of outgoing) {
        if (before.source === after.target) continue;
        edges.push({
          id: edgeId(),
          source: before.source,
          target: after.target,
          ...(before.condition ? { condition: before.condition } : {}),
        });
      }
    }
  }
  nodes = nodes.filter(node => node.type !== 'question' || validFieldIds.has(node.data.fieldId ?? ''));
  const represented = new Set(nodes.filter(node => node.type === 'question').map(node => node.data.fieldId));
  const review = nodes.find(node => node.type === 'review');
  for (const field of fields.filter(item => !represented.has(item.id))) {
    const node: WorkflowGraphNode = {
      id: `question:${field.id}`,
      type: 'question',
      position: { x: review ? review.position.x - 220 : nodes.length * 260, y: 220 },
      data: { fieldId: field.id, label: field.label },
    };
    nodes.push(node);
    if (review) {
      const incoming = edges.filter(edge => edge.target === review.id);
      if (incoming.length === 1) {
        edges = edges.filter(edge => edge.id !== incoming[0].id);
        edges.push({ ...incoming[0], id: edgeId(), target: node.id });
        edges.push({ id: edgeId(), source: node.id, target: review.id });
      }
    }
  }
  return { ...graph, nodes, edges };
}

/**
 * Returns the field order represented by the persisted graph. There is no single
 * runtime order for mutually exclusive branches, so ties in the topological
 * order follow the visual position and then the stable node id.
 */
export function orderWorkflowFieldsByGraph(fields: WorkflowField[], graph: WorkflowGraphDefinition): WorkflowField[] {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as WorkflowGraphEdge[]]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const compareNodes = (leftId: string, rightId: string) => {
    const left = nodeById.get(leftId)!;
    const right = nodeById.get(rightId)!;
    return left.position.x - right.position.x || left.position.y - right.position.y || left.id.localeCompare(right.id);
  };
  const ready = graph.nodes
    .filter(node => incoming.get(node.id) === 0)
    .map(node => node.id)
    .sort(compareNodes);
  const fieldIds: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    const node = nodeById.get(id)!;
    if (node.type === 'question' && node.data.fieldId) fieldIds.push(node.data.fieldId);
    for (const edge of outgoing.get(id) ?? []) {
      incoming.set(edge.target, incoming.get(edge.target)! - 1);
      if (incoming.get(edge.target) === 0) {
        ready.push(edge.target);
        ready.sort(compareNodes);
      }
    }
  }
  const position = new Map(fieldIds.map((id, index) => [id, index]));
  return [...fields]
    .sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.order - right.order ||
        left.id.localeCompare(right.id),
    )
    .map((field, index) => ({ ...field, order: index + 1 }));
}

/** Stable topological order used by the detailed editor to mirror the real execution graph. */
export function orderWorkflowGraphNodes(graph: WorkflowGraphDefinition): WorkflowGraphNode[] {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as WorkflowGraphEdge[]]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge);
  }
  const compare = (leftId: string, rightId: string) => {
    const left = nodeById.get(leftId)!;
    const right = nodeById.get(rightId)!;
    return left.position.x - right.position.x || left.position.y - right.position.y || left.id.localeCompare(right.id);
  };
  const ready = graph.nodes
    .filter(node => incoming.get(node.id) === 0)
    .map(node => node.id)
    .sort(compare);
  const ordered: WorkflowGraphNode[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(nodeById.get(id)!);
    for (const edge of outgoing.get(id) ?? []) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 1) - 1);
      if (incoming.get(edge.target) === 0) {
        ready.push(edge.target);
        ready.sort(compare);
      }
    }
  }
  return ordered.length === graph.nodes.length ? ordered : graph.nodes;
}

/**
 * Reorders the actual execution path when the graph is a single unconditional
 * chain. A branched graph cannot be safely inferred from a flat drag operation,
 * so callers must keep its connections as the source of truth.
 */
export function reorderLinearWorkflowQuestions(
  graph: WorkflowGraphDefinition,
  orderedFieldIds: string[],
): WorkflowGraphDefinition | null {
  if (graph.edges.some(edge => edge.condition)) return null;
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return null;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const sequence: WorkflowGraphNode[] = [];
  const pathEdges: WorkflowGraphEdge[] = [];
  const visited = new Set<string>();
  let current = nodeById.get(graph.startNodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    sequence.push(current);
    const nextEdges = graph.edges.filter(edge => edge.source === current!.id);
    if (current.type === 'review') {
      if (nextEdges.length) return null;
      break;
    }
    if (nextEdges.length !== 1) return null;
    const edge = nextEdges[0];
    if ((incoming.get(edge.target) ?? 0) !== 1) return null;
    pathEdges.push(edge);
    current = nodeById.get(edge.target);
  }
  if (visited.size !== graph.nodes.length || sequence.at(-1)?.type !== 'review') return null;
  const questionNodes = sequence.filter(node => node.type === 'question');
  if (
    questionNodes.length !== orderedFieldIds.length ||
    orderedFieldIds.some(id => !questionNodes.some(node => node.data.fieldId === id))
  )
    return null;
  const orderedQuestions = orderedFieldIds.map(id => questionNodes.find(node => node.data.fieldId === id)!);
  let questionIndex = 0;
  const reorderedSequence = sequence.map(node => (node.type === 'question' ? orderedQuestions[questionIndex++] : node));
  const questionPositions = sequence.filter(node => node.type === 'question').map(node => node.position);
  questionIndex = 0;
  const positions = new Map(
    reorderedSequence
      .filter(node => node.type === 'question')
      .map(node => [node.id, questionPositions[questionIndex++]] as const),
  );
  return {
    ...graph,
    nodes: graph.nodes.map(node =>
      positions.has(node.id) ? { ...node, position: { ...positions.get(node.id)! } } : node,
    ),
    edges: pathEdges.map((edge, index) => ({
      ...edge,
      source: reorderedSequence[index].id,
      target: reorderedSequence[index + 1].id,
    })),
  };
}

/** Moves one message inside a single unconditional execution chain. */
export function moveLinearWorkflowMessage(
  graph: WorkflowGraphDefinition,
  messageNodeId: string,
  offset: -1 | 1,
): WorkflowGraphDefinition | null {
  if (graph.edges.some(edge => edge.condition)) return null;
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return null;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const sequence: WorkflowGraphNode[] = [];
  const pathEdges: WorkflowGraphEdge[] = [];
  const visited = new Set<string>();
  let current = nodeById.get(graph.startNodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    sequence.push(current);
    const nextEdges = graph.edges.filter(edge => edge.source === current!.id);
    if (current.type === 'review') {
      if (nextEdges.length) return null;
      break;
    }
    if (nextEdges.length !== 1) return null;
    const edge = nextEdges[0];
    if ((incoming.get(edge.target) ?? 0) !== 1) return null;
    pathEdges.push(edge);
    current = nodeById.get(edge.target);
  }
  if (visited.size !== graph.nodes.length || sequence.at(-1)?.type !== 'review') return null;
  const index = sequence.findIndex(node => node.id === messageNodeId && node.type === 'message');
  const target = index + offset;
  if (index < 0 || target <= 0 || target >= sequence.length - 1) return graph;
  const nextSequence = [...sequence];
  [nextSequence[index], nextSequence[target]] = [nextSequence[target], nextSequence[index]];
  const positions = new Map([
    [nextSequence[index].id, { ...sequence[index].position }],
    [nextSequence[target].id, { ...sequence[target].position }],
  ]);
  return {
    ...graph,
    nodes: graph.nodes.map(node => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)),
    edges: pathEdges.map((edge, edgeIndex) => ({
      ...edge,
      source: nextSequence[edgeIndex].id,
      target: nextSequence[edgeIndex + 1].id,
    })),
  };
}

/** Repositions a question or message by dropping its header on another editable node. */
export function moveLinearWorkflowNodeTo(
  graph: WorkflowGraphDefinition,
  nodeId: string,
  targetNodeId: string,
): WorkflowGraphDefinition | null {
  if (nodeId === targetNodeId) return graph;
  if (graph.edges.some(edge => edge.condition)) return null;
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return null;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const sequence: WorkflowGraphNode[] = [];
  const pathEdges: WorkflowGraphEdge[] = [];
  const visited = new Set<string>();
  let current = nodeById.get(graph.startNodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    sequence.push(current);
    const nextEdges = graph.edges.filter(edge => edge.source === current!.id);
    if (current.type === 'review') {
      if (nextEdges.length) return null;
      break;
    }
    if (nextEdges.length !== 1) return null;
    const edge = nextEdges[0];
    if ((incoming.get(edge.target) ?? 0) !== 1) return null;
    pathEdges.push(edge);
    current = nodeById.get(edge.target);
  }
  if (visited.size !== graph.nodes.length || sequence.at(-1)?.type !== 'review') return null;
  const sourceIndex = sequence.findIndex(node => node.id === nodeId);
  const targetIndex = sequence.findIndex(node => node.id === targetNodeId);
  if (sourceIndex <= 0 || targetIndex <= 0 || sourceIndex >= sequence.length - 1 || targetIndex >= sequence.length - 1)
    return graph;
  const nextSequence = [...sequence];
  const [moved] = nextSequence.splice(sourceIndex, 1);
  nextSequence.splice(Math.min(targetIndex, nextSequence.length - 1), 0, moved);
  const positions = new Map(nextSequence.map((node, index) => [node.id, { ...sequence[index].position }] as const));
  return {
    ...graph,
    nodes: graph.nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })),
    edges: pathEdges.map((edge, index) => ({
      ...edge,
      source: nextSequence[index].id,
      target: nextSequence[index + 1].id,
    })),
  };
}

/** Removes a message and reconnects every incoming route to its following route. */
export function removeWorkflowMessageNode(
  graph: WorkflowGraphDefinition,
  messageNodeId: string,
): WorkflowGraphDefinition | null {
  const message = graph.nodes.find(node => node.id === messageNodeId);
  if (message?.type !== 'message') return null;
  const incoming = graph.edges.filter(edge => edge.target === messageNodeId);
  const outgoing = graph.edges.filter(edge => edge.source === messageNodeId);
  const bridges: WorkflowGraphEdge[] = [];
  for (const before of incoming) {
    for (const after of outgoing) {
      if (before.source === after.target) continue;
      bridges.push({
        id: edgeId(),
        source: before.source,
        target: after.target,
        ...(before.condition ? { condition: { ...before.condition } } : {}),
      });
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(node => node.id !== messageNodeId),
    edges: [...graph.edges.filter(edge => edge.source !== messageNodeId && edge.target !== messageNodeId), ...bridges],
  };
}

export function syncFieldVisibilityFromGraphEdge(
  fields: WorkflowField[],
  graph: WorkflowGraphDefinition,
  sourceNodeId: string,
  targetNodeId: string,
  condition: WorkflowGraphEdge['condition'],
): WorkflowField[] {
  const sourceNode = graph.nodes.find(node => node.id === sourceNodeId);
  const targetNode = graph.nodes.find(node => node.id === targetNodeId);
  if (sourceNode?.type !== 'question' || targetNode?.type !== 'question') return fields;
  const sourceFieldId = sourceNode.data.fieldId;
  const targetFieldId = targetNode.data.fieldId;
  if (!sourceFieldId || !targetFieldId) return fields;
  // At a merge, an edge condition is only one possible route (OR). Turning it
  // into field visibility would incorrectly constrain every incoming route.
  if (graph.edges.filter(edge => edge.target === targetNodeId).length > 1) return fields;

  return fields.map(field => {
    if (field.id !== targetFieldId) return field;
    if (condition) return { ...field, visibleWhen: { fieldId: sourceFieldId, ...condition } };
    if (field.visibleWhen?.fieldId === sourceFieldId) return { ...field, visibleWhen: undefined };
    return field;
  });
}

export interface WorkflowGraphIssue {
  code: string;
  message: string;
  nodeId?: string;
}

/** Iterative traversal also handles malformed drafts containing cycles. */
export function canConnectWorkflowNodes(graph: WorkflowGraphDefinition, source: string, target: string): boolean {
  const from = graph.nodes.find(node => node.id === source);
  const to = graph.nodes.find(node => node.id === target);
  if (!from || !to || source === target || from.type === 'review' || to.type === 'start') return false;
  if (graph.edges.some(edge => edge.source === source && edge.target === target)) return false;
  const visited = new Set<string>();
  const pending = [target];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of graph.edges) if (edge.source === id) pending.push(edge.target);
  }
  return true;
}

export function inspectWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as WorkflowGraphEdge[]]));
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      issues.push({ code: 'orphan', message: 'Uma ligação aponta para um bloco removido.' });
      continue;
    }
    outgoing.get(edge.source)!.push(edge);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  if (graph.nodes.filter(node => node.type === 'start').length !== 1 || nodes.get(graph.startNodeId)?.type !== 'start')
    issues.push({ code: 'start', message: 'Defina exatamente um bloco inicial.' });
  if (graph.nodes.filter(node => node.type === 'review').length !== 1)
    issues.push({ code: 'review', message: 'Defina exatamente uma revisão final.' });
  for (const node of graph.nodes) {
    const edges = outgoing.get(node.id)!;
    const label = node.data.label || node.id;
    const add = (code: string, message: string) => issues.push({ code, message, nodeId: node.id });
    if (node.type !== 'review' && edges.filter(edge => !edge.condition).length !== 1)
      add('default', `“${label}” precisa de exatamente um caminho padrão.`);
    if (node.type === 'review' && edges.length) add('review-output', 'A revisão final não pode ter saídas.');
    if (node.type === 'start' && indegree.get(node.id)) add('start-input', 'O início não pode receber ligações.');
    if (node.type === 'message' && !node.data.text?.trim()) add('empty-message', `Escreva o texto de “${label}”.`);
    for (const edge of edges.filter(item => item.condition)) {
      if (node.type !== 'question') add('condition-source', 'Somente perguntas podem ter saídas condicionais.');
      const condition = edge.condition!;
      if (condition.operator !== 'filled' && (condition.value == null || String(condition.value).trim() === ''))
        add('condition-value', `Escolha a resposta esperada na saída de “${label}”.`);
    }
  }
  const reachable = new Set<string>();
  const pending = [graph.startNodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id) || !nodes.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id)!) pending.push(edge.target);
  }
  for (const node of graph.nodes)
    if (!reachable.has(node.id))
      issues.push({
        code: 'unreachable',
        nodeId: node.id,
        message: `“${node.data.label || node.id}” não é alcançado pelo início.`,
      });
  const queue = graph.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed += 1;
    for (const edge of outgoing.get(id)!) {
      indegree.set(edge.target, indegree.get(edge.target)! - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  if (processed !== graph.nodes.length)
    issues.push({
      code: 'cycle',
      message: 'Existe um caminho que volta a uma etapa anterior. Remova a ligação que cria a repetição.',
    });
  return issues;
}

export function organizeWorkflowGraph(graph: WorkflowGraphDefinition): WorkflowGraphDefinition {
  // Refuse cycles before computing longest-path columns; otherwise a loop
  // could keep increasing the column forever and freeze the browser.
  if (inspectWorkflowGraph(graph).some(issue => issue.code === 'cycle' || issue.code === 'orphan')) return graph;
  const levels = new Map<string, number>([[graph.startNodeId, 0]]);
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) incoming.set(edge.target, incoming.get(edge.target)! + 1);
  const queue = graph.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of graph.edges.filter(item => item.source === source)) {
      levels.set(edge.target, Math.max(levels.get(edge.target) ?? 0, (levels.get(source) ?? 0) + 1));
      incoming.set(edge.target, incoming.get(edge.target)! - 1);
      if (incoming.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  const rows = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      const column = levels.get(node.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return { ...node, position: { x: column * 270, y: 60 + row * 160 } };
    }),
  };
}
