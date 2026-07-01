// Queue names used across the application
// Extracted to separate file to avoid circular dependency with processors
export const QUEUE_NAMES = {
  WEBHOOK: 'webhook-queue',
  INGRESS: 'ingress-queue',
} as const;
