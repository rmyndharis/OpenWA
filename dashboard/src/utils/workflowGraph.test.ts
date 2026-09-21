import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowField, WorkflowGraphDefinition } from '../services/api.ts';
import {
  createLinearWorkflowGraph,
  reconcileWorkflowGraph,
  syncFieldVisibilityFromGraphEdge,
  canConnectWorkflowNodes,
  inspectWorkflowGraph,
  orderWorkflowFieldsByGraph,
  orderWorkflowGraphNodes,
  moveLinearWorkflowMessage,
  moveLinearWorkflowNodeTo,
  organizeWorkflowGraph,
  removeWorkflowMessageNode,
  reorderLinearWorkflowQuestions,
} from './workflowGraph.ts';

const field = (id: string): WorkflowField => ({
  id,
  answerKey: id,
  label: `Pergunta ${id}`,
  prompt: `Informe ${id}`,
  type: 'text',
  required: true,
  order: 1,
});

test('creates a complete linear diagram from the configured questions', () => {
  const graph = createLinearWorkflowGraph([field('nome'), field('email')]);

  assert.equal(graph.startNodeId, 'flow_start');
  assert.deepEqual(
    graph.nodes.map(node => node.id),
    ['flow_start', 'question:nome', 'question:email', 'flow_review'],
  );
  assert.deepEqual(
    graph.edges.map(edge => [edge.source, edge.target]),
    [
      ['flow_start', 'question:nome'],
      ['question:nome', 'question:email'],
      ['question:email', 'flow_review'],
    ],
  );
});

test('removing a question preserves its surrounding path', () => {
  const original = createLinearWorkflowGraph([field('nome'), field('email'), field('cidade')]);
  const graph = reconcileWorkflowGraph(original, [field('nome'), field('cidade')]);

  assert.equal(
    graph.nodes.some(node => node.id === 'question:email'),
    false,
  );
  assert.equal(
    graph.edges.some(edge => edge.source === 'question:nome' && edge.target === 'question:cidade'),
    true,
  );
});

test('adding a question inserts it before the final review in a linear diagram', () => {
  const original: WorkflowGraphDefinition = createLinearWorkflowGraph([field('nome')]);
  const graph = reconcileWorkflowGraph(original, [field('nome'), field('email')]);

  assert.equal(
    graph.nodes.some(node => node.id === 'question:email'),
    true,
  );
  assert.equal(
    graph.edges.some(edge => edge.source === 'question:nome' && edge.target === 'question:email'),
    true,
  );
  assert.equal(
    graph.edges.some(edge => edge.source === 'question:email' && edge.target === 'flow_review'),
    true,
  );
});

test('a conditional diagram connection updates the target question rule', () => {
  const fields = [field('area'), field('experiencia')];
  const graph = createLinearWorkflowGraph(fields);
  const synced = syncFieldVisibilityFromGraphEdge(fields, graph, 'question:area', 'question:experiencia', {
    operator: 'equals',
    value: 'Primeiro Emprego',
  });

  assert.deepEqual(synced[1].visibleWhen, {
    fieldId: 'area',
    operator: 'equals',
    value: 'Primeiro Emprego',
  });
});

test('changing a diagram connection back to default clears its matching question rule', () => {
  const fields = [
    field('area'),
    {
      ...field('experiencia'),
      visibleWhen: { fieldId: 'area', operator: 'equals' as const, value: 'Com experiência' },
    },
  ];
  const graph = createLinearWorkflowGraph(fields);
  const synced = syncFieldVisibilityFromGraphEdge(fields, graph, 'question:area', 'question:experiencia', undefined);

  assert.equal(synced[1].visibleWhen, undefined);
});

test('message connections do not alter question visibility rules', () => {
  const fields = [field('area'), field('experiencia')];
  const graph = createLinearWorkflowGraph(fields);
  graph.nodes.push({
    id: 'message:info',
    type: 'message',
    position: { x: 200, y: 200 },
    data: { label: 'Informação', text: 'Mensagem' },
  });

  const synced = syncFieldVisibilityFromGraphEdge(fields, graph, 'question:area', 'message:info', {
    operator: 'equals',
    value: 'Primeiro Emprego',
  });

  assert.equal(synced, fields);
});

test('merge routes do not restrict a shared question to only one incoming answer', () => {
  const fields = [field('area'), field('nome'), field('cidade')];
  const graph = createLinearWorkflowGraph(fields);
  graph.edges.push({
    id: 'shortcut',
    source: 'question:area',
    target: 'question:cidade',
    condition: { operator: 'equals', value: 'Direto' },
  });
  const next = syncFieldVisibilityFromGraphEdge(fields, graph, 'question:area', 'question:cidade', {
    operator: 'equals',
    value: 'Direto',
  });
  assert.equal(next, fields);
  assert.equal(next[2].visibleWhen, undefined);
});

test('rejects backward connections and duplicates but accepts forward branches', () => {
  const graph = createLinearWorkflowGraph([field('a'), field('b'), field('c')]);
  assert.equal(canConnectWorkflowNodes(graph, 'question:c', 'question:a'), false);
  assert.equal(canConnectWorkflowNodes(graph, 'question:a', 'question:b'), false);
  assert.equal(canConnectWorkflowNodes(graph, 'question:a', 'question:c'), true);
  assert.equal(canConnectWorkflowNodes(graph, 'flow_review', 'question:a'), false);
});

test('organize terminates safely for an already corrupt cyclic draft', { timeout: 1000 }, () => {
  const graph = createLinearWorkflowGraph([field('a'), field('b')]);
  graph.edges.push({ id: 'loop', source: 'question:b', target: 'question:a', condition: { operator: 'filled' } });
  assert.ok(inspectWorkflowGraph(graph).some(issue => issue.code === 'cycle'));
  assert.equal(organizeWorkflowGraph(graph), graph);
});

test('diagnostics report missing defaults, empty messages and unreachable blocks', () => {
  const graph = createLinearWorkflowGraph([field('a')]);
  graph.edges = graph.edges.filter(edge => edge.source !== 'question:a');
  graph.nodes.push({ id: 'unused', type: 'message', position: { x: 0, y: 0 }, data: { label: 'Aviso', text: '' } });
  const issues = inspectWorkflowGraph(graph);
  assert.ok(issues.some(issue => issue.code === 'default' && issue.nodeId === 'question:a'));
  assert.ok(issues.some(issue => issue.code === 'empty-message' && issue.nodeId === 'unused'));
  assert.ok(issues.some(issue => issue.code === 'unreachable' && issue.nodeId === 'flow_review'));
});

test('organize preserves branch conditions, content and connections', () => {
  const graph = createLinearWorkflowGraph([field('a'), field('b'), field('c')]);
  graph.edges.push({
    id: 'shortcut',
    source: 'question:a',
    target: 'question:c',
    condition: { operator: 'equals', value: false },
  });
  assert.deepEqual(inspectWorkflowGraph(graph), []);
  const organized = organizeWorkflowGraph(graph);
  assert.deepEqual(organized.edges, graph.edges);
  for (const node of graph.nodes) assert.deepEqual(organized.nodes.find(item => item.id === node.id)?.data, node.data);
  const x = (id: string) => organized.nodes.find(node => node.id === id)!.position.x;
  assert.ok(x('question:c') > x('question:b'));
});

test('orders the detailed question list by the persisted execution graph', () => {
  const fields = [field('area'), field('experiencia'), field('turno'), field('curriculo')];
  const graph = createLinearWorkflowGraph([fields[0], fields[2], fields[3], fields[1]]);
  assert.deepEqual(
    orderWorkflowFieldsByGraph(fields, graph).map(item => item.id),
    ['area', 'turno', 'curriculo', 'experiencia'],
  );
});

test('shows an inserted message between the same questions used by execution', () => {
  const graph = createLinearWorkflowGraph([field('nome'), field('email')]);
  graph.nodes.push({
    id: 'message:intro',
    type: 'message',
    position: { x: 390, y: 80 },
    data: { label: 'Apresentação', text: 'Olá' },
  });
  graph.edges = [
    { id: 'a', source: 'flow_start', target: 'question:nome' },
    { id: 'b', source: 'question:nome', target: 'message:intro' },
    { id: 'c', source: 'message:intro', target: 'question:email' },
    { id: 'd', source: 'question:email', target: 'flow_review' },
  ];
  assert.deepEqual(
    orderWorkflowGraphNodes(graph).map(node => node.id),
    ['flow_start', 'question:nome', 'message:intro', 'question:email', 'flow_review'],
  );
});

test('moves a message inside a linear execution path without changing its content', () => {
  const graph = createLinearWorkflowGraph([field('nome'), field('email')]);
  graph.nodes.push({
    id: 'message:intro',
    type: 'message',
    position: { x: 650, y: 80 },
    data: { label: 'Apresentação', text: 'Olá' },
  });
  graph.edges = [
    { id: 'a', source: 'flow_start', target: 'question:nome' },
    { id: 'b', source: 'question:nome', target: 'question:email' },
    { id: 'c', source: 'question:email', target: 'message:intro' },
    { id: 'd', source: 'message:intro', target: 'flow_review' },
  ];
  const moved = moveLinearWorkflowMessage(graph, 'message:intro', -1);
  assert.ok(moved);
  assert.deepEqual(
    orderWorkflowGraphNodes(moved).map(node => node.id),
    ['flow_start', 'question:nome', 'message:intro', 'question:email', 'flow_review'],
  );
  assert.equal(moved.nodes.find(node => node.id === 'message:intro')?.data.text, 'Olá');
});

test('moves questions and messages by dropping their headers on another card', () => {
  const graph = createLinearWorkflowGraph([field('nome'), field('email')]);
  graph.nodes.push({
    id: 'message:intro',
    type: 'message',
    position: { x: 650, y: 80 },
    data: { label: 'Apresentação', text: 'Olá' },
  });
  graph.edges = [
    { id: 'a', source: 'flow_start', target: 'question:nome' },
    { id: 'b', source: 'question:nome', target: 'question:email' },
    { id: 'c', source: 'question:email', target: 'message:intro' },
    { id: 'd', source: 'message:intro', target: 'flow_review' },
  ];
  const moved = moveLinearWorkflowNodeTo(graph, 'message:intro', 'question:nome');
  assert.ok(moved);
  assert.deepEqual(
    orderWorkflowGraphNodes(moved).map(node => node.id),
    ['flow_start', 'message:intro', 'question:nome', 'question:email', 'flow_review'],
  );
});

test('moves a question across an inserted message without losing either block', () => {
  const fields = [field('nome'), field('email')];
  const graph = createLinearWorkflowGraph(fields);
  graph.nodes.push({
    id: 'message:intro',
    type: 'message',
    position: { x: 520, y: 80 },
    data: { label: 'Apresentação', text: 'Olá' },
  });
  graph.edges = [
    { id: 'a', source: 'flow_start', target: 'question:nome' },
    { id: 'b', source: 'question:nome', target: 'message:intro' },
    { id: 'c', source: 'message:intro', target: 'question:email' },
    { id: 'd', source: 'question:email', target: 'flow_review' },
  ];

  const moved = moveLinearWorkflowNodeTo(graph, 'question:email', 'message:intro');

  assert.ok(moved);
  assert.deepEqual(
    orderWorkflowGraphNodes(moved).map(node => node.id),
    ['flow_start', 'question:nome', 'question:email', 'message:intro', 'flow_review'],
  );
  assert.deepEqual(
    orderWorkflowFieldsByGraph(fields, moved).map(item => item.id),
    ['nome', 'email'],
  );
  assert.equal(moved.nodes.find(node => node.id === 'message:intro')?.data.text, 'Olá');
});

test('removes an inserted message while preserving the surrounding execution path', () => {
  const graph = createLinearWorkflowGraph([field('nome'), field('email')]);
  graph.nodes.push({
    id: 'message:intro',
    type: 'message',
    position: { x: 520, y: 80 },
    data: { label: 'Apresentação', text: 'Olá' },
  });
  graph.edges = [
    { id: 'a', source: 'flow_start', target: 'question:nome' },
    { id: 'b', source: 'question:nome', target: 'message:intro' },
    { id: 'c', source: 'message:intro', target: 'question:email' },
    { id: 'd', source: 'question:email', target: 'flow_review' },
  ];

  const withoutMessage = removeWorkflowMessageNode(graph, 'message:intro');

  assert.ok(withoutMessage);
  assert.deepEqual(
    orderWorkflowGraphNodes(withoutMessage).map(node => node.id),
    ['flow_start', 'question:nome', 'question:email', 'flow_review'],
  );
  assert.ok(withoutMessage.edges.some(edge => edge.source === 'question:nome' && edge.target === 'question:email'));
});

test('reorders a linear graph when questions are dragged in the detailed list', () => {
  const fields = [field('area'), field('experiencia'), field('turno')];
  const graph = createLinearWorkflowGraph(fields);
  const reordered = reorderLinearWorkflowQuestions(graph, ['area', 'turno', 'experiencia']);
  assert.ok(reordered);
  assert.deepEqual(
    orderWorkflowFieldsByGraph(fields, reordered).map(item => item.id),
    ['area', 'turno', 'experiencia'],
  );
  assert.deepEqual(
    reordered.edges.map(edge => [edge.source, edge.target]),
    [
      ['flow_start', 'question:area'],
      ['question:area', 'question:turno'],
      ['question:turno', 'question:experiencia'],
      ['question:experiencia', 'flow_review'],
    ],
  );
});

test('refuses to flatten a branched graph from a list drag', () => {
  const fields = [field('area'), field('experiencia'), field('turno')];
  const graph = createLinearWorkflowGraph(fields);
  graph.edges.push({
    id: 'branch',
    source: 'question:area',
    target: 'question:turno',
    condition: { operator: 'equals', value: 'Primeiro emprego' },
  });
  assert.equal(reorderLinearWorkflowQuestions(graph, ['area', 'turno', 'experiencia']), null);
});
