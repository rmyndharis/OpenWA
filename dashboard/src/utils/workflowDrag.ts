export interface PointerDragOrigin {
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

export function hasPointerDragStarted(origin: PointerDragOrigin, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - origin.startX, clientY - origin.startY) >= 6;
}

export function workflowDragPreviewPosition(origin: PointerDragOrigin, clientX: number, clientY: number) {
  return {
    x: clientX - origin.offsetX,
    y: clientY - origin.offsetY,
  };
}
