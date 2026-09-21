const editingTabs = new Set(['flows', 'diagram', 'settings']);

export const WORKFLOW_AGENDA_REFRESH_MS = 5_000;
export const WORKFLOW_HUMAN_TICKETS_REFRESH_MS = 5_000;

export function shouldPollWorkflowTab(tab: string): boolean {
  return !editingTabs.has(tab);
}

/** Only the newest request in the active session may update the screen. */
export class WorkflowRequestGate {
  private revision = 0;

  begin(): () => boolean {
    const revision = ++this.revision;
    return () => revision === this.revision;
  }

  invalidate(): void {
    this.revision += 1;
  }
}
