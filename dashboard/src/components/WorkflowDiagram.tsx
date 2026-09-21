import { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GitBranch, MessageSquareText, Play, Send, ShieldCheck, Trash2 } from 'lucide-react';
import type { WorkflowField, WorkflowGraphDefinition, WorkflowGraphEdge, WorkflowGraphNode } from '../services/api';
import {
  canConnectWorkflowNodes,
  inspectWorkflowGraph,
  organizeWorkflowGraph,
  removeWorkflowMessageNode,
  syncFieldVisibilityFromGraphEdge,
} from '../utils/workflowGraph';

interface WorkflowDiagramProps {
  fields: WorkflowField[];
  graph: WorkflowGraphDefinition;
  editable: boolean;
  onChange: (graph: WorkflowGraphDefinition) => void;
  onFieldsChange: (fields: WorkflowField[]) => void;
}

const edgeId = () => `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const messageId = () => `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function DiagramNode({ data, kind }: { data: Record<string, unknown>; kind: WorkflowGraphNode['type'] }) {
  const icon =
    kind === 'start' ? (
      <Play size={17} />
    ) : kind === 'message' ? (
      <MessageSquareText size={17} />
    ) : kind === 'review' ? (
      <ShieldCheck size={17} />
    ) : (
      <Send size={17} />
    );
  return (
    <div className={`workflow-diagram-node kind-${kind}`}>
      {kind !== 'start' && <Handle type="target" position={Position.Left} />}
      <span className="workflow-node-kind">
        {icon}
        {kind === 'start'
          ? 'Início'
          : kind === 'message'
            ? 'Mensagem'
            : kind === 'review'
              ? 'Finalização'
              : `Pergunta${typeof data.stepNumber === 'number' ? ` ${data.stepNumber}` : ''}`}
      </span>
      <strong>{String(data.label ?? 'Etapa')}</strong>
      {kind === 'question' && typeof data.pathLabel === 'string' && data.pathLabel && (
        <small className="workflow-node-path">{data.pathLabel}</small>
      )}
      {kind === 'message' && <small>{String(data.text ?? '')}</small>}
      {kind !== 'review' && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = {
  start: (props: { data: Record<string, unknown> }) => <DiagramNode {...props} kind="start" />,
  message: (props: { data: Record<string, unknown> }) => <DiagramNode {...props} kind="message" />,
  question: (props: { data: Record<string, unknown> }) => <DiagramNode {...props} kind="question" />,
  review: (props: { data: Record<string, unknown> }) => <DiagramNode {...props} kind="review" />,
};

export function WorkflowDiagram({ fields, graph, editable, onChange, onFieldsChange }: WorkflowDiagramProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const issues = useMemo(() => inspectWorkflowGraph(graph), [graph]);
  const fieldById = useMemo(() => new Map(fields.map(field => [field.id, field])), [fields]);
  const graphNodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const selectedNode = graph.nodes.find(node => node.id === selectedNodeId);
  const selectedEdge = graph.edges.find(edge => edge.id === selectedEdgeId);
  const selectedEdgeSource = selectedEdge ? graphNodeById.get(selectedEdge.source) : undefined;
  const selectedEdgeField = selectedEdgeSource?.data.fieldId
    ? fieldById.get(selectedEdgeSource.data.fieldId)
    : undefined;

  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map(node => {
        const field = node.data.fieldId ? fieldById.get(node.data.fieldId) : undefined;
        return {
          id: node.id,
          type: node.type,
          position: node.position,
          selected: node.id === selectedNodeId,
          draggable: editable,
          data: {
            ...node.data,
            label: node.type === 'question' ? field?.label || 'Pergunta removida' : node.data.label,
            stepNumber: field?.order,
            pathLabel:
              node.type === 'question' && field?.visibleWhen
                ? `${fields.find(item => item.id === field.visibleWhen?.fieldId)?.label ?? 'Pergunta'}: ${
                    field.visibleWhen.operator === 'filled'
                      ? 'respondida'
                      : `${field.visibleWhen.operator === 'equals' ? '=' : field.visibleWhen.operator === 'notEquals' ? '≠' : 'contém'} ${String(field.visibleWhen.value ?? '')}`
                  }`
                : undefined,
          },
        };
      }),
    [editable, fieldById, fields, graph.nodes, selectedNodeId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        selected: edge.id === selectedEdgeId,
        label: edge.condition
          ? edge.condition.operator === 'filled'
            ? 'se respondida'
            : `${edge.condition.operator === 'equals' ? '=' : edge.condition.operator === 'notEquals' ? '≠' : 'contém'} ${String(edge.condition.value ?? '')}`
          : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        type: 'smoothstep',
      })),
    [graph.edges, selectedEdgeId],
  );

  const updateNode = (id: string, patch: Partial<WorkflowGraphNode['data']>) =>
    onChange({
      ...graph,
      nodes: graph.nodes.map(node => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)),
    });
  const syncTargetFieldCondition = (
    sourceNodeId: string,
    targetNodeId: string,
    condition: WorkflowGraphEdge['condition'],
  ) => {
    const nextFields = syncFieldVisibilityFromGraphEdge(fields, graph, sourceNodeId, targetNodeId, condition);
    if (nextFields !== fields) onFieldsChange(nextFields);
  };
  const updateEdge = (id: string, condition: WorkflowGraphEdge['condition']) => {
    const edge = graph.edges.find(item => item.id === id);
    if (
      !condition &&
      edge &&
      graph.edges.some(item => item.id !== id && item.source === edge.source && !item.condition)
    ) {
      setNotice('Esta pergunta já possui um caminho padrão. Altere ou remova o caminho anterior primeiro.');
      return;
    }
    onChange({
      ...graph,
      edges: graph.edges.map(edge => (edge.id === id ? { ...edge, condition } : edge)),
    });
    if (edge) syncTargetFieldCondition(edge.source, edge.target, condition);
  };
  const insertMessage = () => {
    const edge =
      graph.edges.find(item => item.id === selectedEdgeId) ?? graph.edges.find(item => item.target === 'flow_review');
    const source = edge ? graphNodeById.get(edge.source) : undefined;
    const target = edge ? graphNodeById.get(edge.target) : undefined;
    const id = messageId();
    const node: WorkflowGraphNode = {
      id,
      type: 'message',
      position: {
        x: source && target ? (source.position.x + target.position.x) / 2 : 260,
        y: source && target ? (source.position.y + target.position.y) / 2 + 80 : 280,
      },
      data: { label: 'Nova mensagem', text: 'Digite aqui a mensagem que será enviada.' },
    };
    const nextEdges = edge
      ? [
          ...graph.edges.filter(item => item.id !== edge.id),
          { id: edgeId(), source: edge.source, target: id, ...(edge.condition ? { condition: edge.condition } : {}) },
          { id: edgeId(), source: id, target: edge.target },
        ]
      : graph.edges;
    onChange({ ...graph, nodes: [...graph.nodes, node], edges: nextEdges });
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setNotice(edge ? 'Mensagem inserida na ligação selecionada.' : 'Mensagem criada; conecte-a ao fluxo.');
  };
  const removeMessage = () => {
    if (!selectedNode || selectedNode.type !== 'message') return;
    const next = removeWorkflowMessageNode(graph, selectedNode.id);
    if (next) onChange(next);
    setSelectedNodeId(null);
  };
  const organize = () => {
    if (!editable) return;
    const organized = organizeWorkflowGraph(graph);
    if (organized === graph) setNotice('Corrija as ligações inválidas antes de organizar o diagrama.');
    else onChange(organized);
  };
  const onNodesChange = (changes: NodeChange[]) => {
    if (!editable) return;
    const positions = new Map<string, { x: number; y: number }>();
    for (const change of changes) {
      if (change.type === 'position' && change.position) positions.set(change.id, change.position);
    }
    if (!positions.size) return;
    onChange({
      ...graph,
      nodes: graph.nodes.map(node => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)),
    });
  };
  const onConnect = (connection: Connection) => {
    if (!editable || !connection.source || !connection.target || connection.source === connection.target) return;
    if (!canConnectWorkflowNodes(graph, connection.source, connection.target)) {
      setNotice('Ligação inválida: ela repete um caminho, cria um ciclo ou usa um bloco incompatível.');
      return;
    }
    const source = graphNodeById.get(connection.source);
    const target = graphNodeById.get(connection.target);
    if (!source || !target || source.type === 'review' || target.type === 'start') return;
    if (graph.edges.some(edge => edge.source === source.id && edge.target === target.id)) {
      setNotice('Esses blocos já estão conectados.');
      return;
    }
    const existing = graph.edges.filter(edge => edge.source === source.id);
    const condition =
      source.type === 'question' && existing.some(edge => !edge.condition)
        ? { operator: 'equals' as const, value: fieldById.get(source.data.fieldId ?? '')?.options?.[0] ?? '' }
        : undefined;
    const nextGraph: WorkflowGraphDefinition = {
      ...graph,
      edges: [
        ...graph.edges.filter(edge => source.type === 'question' || edge.source !== source.id),
        { id: edgeId(), source: source.id, target: target.id, ...(condition ? { condition } : {}) },
      ],
    };
    onChange(nextGraph);
    if (condition) {
      const nextFields = syncFieldVisibilityFromGraphEdge(fields, nextGraph, source.id, target.id, condition);
      if (nextFields !== fields) onFieldsChange(nextFields);
    }
    setNotice(
      condition
        ? 'Conexão condicional criada. Selecione-a e configure a resposta.'
        : existing.length
          ? 'O caminho anterior foi substituído pela nova conexão.'
          : 'Conexão criada.',
    );
  };

  return (
    <section className="workflow-diagram-shell">
      <header className="workflow-diagram-toolbar">
        <div>
          <strong>Diagrama da conversa</strong>
          <span>Selecione uma ligação para inserir uma mensagem exatamente naquele ponto.</span>
        </div>
        <div>
          <button className="btn-secondary" type="button" onClick={organize} disabled={!editable}>
            <GitBranch size={15} /> Organizar
          </button>
          {editable && (
            <button className="btn-primary" type="button" onClick={insertMessage}>
              <MessageSquareText size={15} /> Inserir mensagem
            </button>
          )}
        </div>
      </header>
      <div className="workflow-diagram-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          isValidConnection={connection =>
            editable && canConnectWorkflowNodes(graph, connection.source, connection.target)
          }
          onNodeClick={(_, node) => {
            setSelectedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          nodesConnectable={editable}
          elementsSelectable
          deleteKeyCode={null}
          fitView
          minZoom={0.25}
          maxZoom={1.5}
        >
          <Background gap={18} size={1} />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>
      {notice && (
        <div className="workflow-diagram-notice" role="status">
          {notice}
        </div>
      )}
      <details className="workflow-diagram-diagnostics" open={issues.length > 0}>
        <summary>
          {issues.length
            ? `${issues.length} ajuste(s) nas conexões antes de salvar`
            : 'Conexões verificadas: todos os blocos alcançáveis e sem ciclos'}
        </summary>
        {issues.length > 0 && (
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.code}:${issue.nodeId ?? ''}:${index}`}>
                {issue.nodeId ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setSelectedNodeId(issue.nodeId!);
                      setSelectedEdgeId(null);
                    }}
                  >
                    {issue.message}
                  </button>
                ) : (
                  issue.message
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
      {selectedNode?.type === 'message' && (
        <div className="workflow-diagram-inspector">
          <label>
            <strong>Nome interno do bloco</strong>
            <input
              value={selectedNode.data.label ?? ''}
              onChange={event => updateNode(selectedNode.id, { label: event.target.value })}
              disabled={!editable}
            />
          </label>
          <label className="inspector-message">
            <strong>Mensagem enviada no WhatsApp</strong>
            <textarea
              rows={3}
              value={selectedNode.data.text ?? ''}
              onChange={event => updateNode(selectedNode.id, { text: event.target.value })}
              disabled={!editable}
            />
          </label>
          {editable && (
            <button className="icon-danger" type="button" onClick={removeMessage}>
              <Trash2 size={15} /> Remover mensagem
            </button>
          )}
        </div>
      )}
      {selectedNode?.type === 'question' &&
        (() => {
          const selectedField = selectedNode.data.fieldId ? fieldById.get(selectedNode.data.fieldId) : undefined;
          if (!selectedField) return null;
          return (
            <div className="workflow-diagram-inspector question-inspector">
              <label>
                <strong>Título da pergunta</strong>
                <input
                  value={selectedField.label}
                  disabled={!editable}
                  onChange={event =>
                    onFieldsChange(
                      fields.map(field =>
                        field.id === selectedField.id ? { ...field, label: event.target.value } : field,
                      ),
                    )
                  }
                />
              </label>
              <label className="inspector-message">
                <strong>Texto enviado no WhatsApp</strong>
                <textarea
                  rows={3}
                  value={selectedField.prompt}
                  disabled={!editable}
                  onChange={event =>
                    onFieldsChange(
                      fields.map(field =>
                        field.id === selectedField.id ? { ...field, prompt: event.target.value } : field,
                      ),
                    )
                  }
                />
              </label>
              <label className="workflow-question-required">
                <input
                  type="checkbox"
                  checked={selectedField.required}
                  disabled={!editable}
                  onChange={event =>
                    onFieldsChange(
                      fields.map(field =>
                        field.id === selectedField.id ? { ...field, required: event.target.checked } : field,
                      ),
                    )
                  }
                />
                Pergunta obrigatória
              </label>
            </div>
          );
        })()}
      {selectedEdge && (
        <div className="workflow-diagram-inspector edge-inspector">
          {selectedEdgeField ? (
            <>
              <label>
                <strong>Quando seguir esta ligação?</strong>
                <select
                  value={selectedEdge.condition?.operator ?? 'default'}
                  disabled={!editable}
                  onChange={event =>
                    updateEdge(
                      selectedEdge.id,
                      event.target.value === 'default'
                        ? undefined
                        : {
                            operator: event.target.value as NonNullable<WorkflowGraphEdge['condition']>['operator'],
                            value: selectedEdge.condition?.value,
                          },
                    )
                  }
                >
                  <option value="default">Caminho padrão</option>
                  <option value="equals">Resposta for igual a</option>
                  <option value="notEquals">Resposta for diferente de</option>
                  <option value="contains">Resposta contiver</option>
                  <option value="filled">Resposta estiver preenchida</option>
                </select>
              </label>
              {selectedEdge.condition && selectedEdge.condition.operator !== 'filled' && (
                <label>
                  <strong>Resposta esperada</strong>
                  {selectedEdgeField.options?.length ? (
                    <select
                      value={String(selectedEdge.condition.value ?? '')}
                      disabled={!editable}
                      onChange={event =>
                        updateEdge(selectedEdge.id, { ...selectedEdge.condition!, value: event.target.value })
                      }
                    >
                      <option value="">Escolha a resposta</option>
                      {selectedEdgeField.options.map(option => (
                        <option value={option} key={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={String(selectedEdge.condition.value ?? '')}
                      disabled={!editable}
                      onChange={event =>
                        updateEdge(selectedEdge.id, { ...selectedEdge.condition!, value: event.target.value })
                      }
                    />
                  )}
                </label>
              )}
            </>
          ) : (
            <div className="workflow-diagram-path-info">
              <strong>Caminho direto</strong>
              <span>Esta ligação segue sempre para o próximo bloco.</span>
            </div>
          )}
          {editable && (
            <button
              className="icon-danger"
              type="button"
              onClick={() => {
                syncTargetFieldCondition(selectedEdge.source, selectedEdge.target, undefined);
                onChange({ ...graph, edges: graph.edges.filter(edge => edge.id !== selectedEdge.id) });
                setSelectedEdgeId(null);
              }}
            >
              <Trash2 size={15} /> Remover ligação
            </button>
          )}
        </div>
      )}
    </section>
  );
}
