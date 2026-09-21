import { useLayoutEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Send } from 'lucide-react';
import type { WorkflowField, WorkflowGraphDefinition, WorkflowSlot } from '../services/api';
import {
  answerWorkflowSimulation,
  scrollWorkflowSimulatorToLatest,
  startWorkflowSimulation,
  type WorkflowSimulationState,
} from '../utils/workflowSimulator';

export function WorkflowSimulator({
  graph,
  fields,
  slots = [],
}: {
  graph: WorkflowGraphDefinition;
  fields: WorkflowField[];
  slots?: WorkflowSlot[];
}) {
  const [simulation, setSimulation] = useState<WorkflowSimulationState | null>(null);
  const [answer, setAnswer] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const messageCount = simulation?.messages.length ?? 0;
  useLayoutEffect(() => {
    scrollWorkflowSimulatorToLatest(chatRef.current);
  }, [messageCount, simulation?.error]);
  const restart = () => {
    setSimulation(startWorkflowSimulation(graph, fields, slots));
    setAnswer('');
  };
  const send = () => {
    if (!simulation || !answer.trim()) return;
    const next = answerWorkflowSimulation(simulation, answer, graph, fields, slots);
    setSimulation(next);
    if (!next.error) setAnswer('');
  };
  return (
    <article className="workflow-simulator">
      <header>
        <div>
          <strong>Simular caminho</strong>
          <span>Prévia local: não grava dados nem envia mensagens.</span>
        </div>
        <button type="button" className="btn-secondary" onClick={restart}>
          {simulation ? <RotateCcw size={15} /> : <Play size={15} />} {simulation ? 'Recomeçar' : 'Iniciar simulação'}
        </button>
      </header>
      {simulation && (
        <>
          <div ref={chatRef} className="workflow-simulator-chat" aria-live="polite">
            {simulation.messages.map(message => (
              <div key={message.id} className={`workflow-simulator-bubble ${message.side}`}>
                {message.text}
              </div>
            ))}
            {simulation.error && <div className="workflow-simulator-error">{simulation.error}</div>}
          </div>
          {!simulation.complete && simulation.currentFieldId && (
            <form
              onSubmit={event => {
                event.preventDefault();
                send();
              }}
            >
              <input
                aria-label="Resposta da simulação"
                value={answer}
                onChange={event => setAnswer(event.target.value)}
                placeholder="Digite uma resposta de teste"
              />
              <button className="btn-primary" disabled={!answer.trim()}>
                <Send size={15} /> Enviar
              </button>
            </form>
          )}
        </>
      )}
    </article>
  );
}
