// The events a webhook can subscribe to, plus the '*' wildcard. Must match the backend WEBHOOK_EVENTS
// (the create/update enum in openapi.json): the API rejects unknown event names, so offering e.g. the
// never-emitted 'session.connected' would 400 on save. webhookEvents.test.ts pins both that match and
// a description for every event under webhooks.eventDescriptions.
export const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.reaction',
  'message.edited',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'session.reconnect_loop',
  'session.restriction',
  'presence.update',
  'event.response',
  'group.join',
  'group.leave',
  'group.update',
  'group.join_request',
  'call.received',
  'call.accepted',
  'call.rejected',
  'call.missed',
  'status.received',
  '*',
] as const;
