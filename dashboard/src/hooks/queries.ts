import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionApi,
  webhookApi,
  templateApi,
  apiKeyApi,
  auditApi,
  infraApi,
  pluginsApi,
  pluginInstancesApi,
  statsApi,
  type Webhook,
  type WebhookFilters,
  type TemplatePayload,
  type StatsPeriod,
  type CreateInstanceInput,
  type UpdateInstanceInput,
} from '../services/api';

// ── Query Keys ────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  sessionStats: ['sessions', 'stats'] as const,
  sessionGroups: (sessionId: string) => ['sessions', sessionId, 'groups'] as const,
  sessionChats: (sessionId: string) => ['sessions', sessionId, 'chats'] as const,
  webhooks: ['webhooks'] as const,
  templates: (sessionId: string) => ['sessions', sessionId, 'templates'] as const,
  apiKeys: ['apiKeys'] as const,
  logs: (params: { severity?: string; page: number; limit: number }) =>
    ['logs', params] as const,
  infraStatus: ['infra', 'status'] as const,
  plugins: ['plugins'] as const,
  pluginInstances: (pluginId: string) => ['plugins', pluginId, 'instances'] as const,
  engines: ['engines'] as const,
  currentEngine: ['engines', 'current'] as const,
  statsOverview: ['stats', 'overview'] as const,
  statsMessages: (period: string) => ['stats', 'messages', period] as const,
};

// ── Session Queries ───────────────────────────────────────────────────

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: sessionApi.list,
    staleTime: 30_000,
  });
}

export function useSessionStatsQuery() {
  return useQuery({
    queryKey: queryKeys.sessionStats,
    queryFn: sessionApi.getStats,
    staleTime: 30_000,
  });
}

export function useSessionGroupsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionGroups(sessionId),
    queryFn: () => sessionApi.getGroups(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useSessionChatsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId),
    queryFn: () => sessionApi.getChats(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.stop(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ── Webhook Queries ───────────────────────────────────────────────────

export function useWebhooksQuery() {
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: webhookApi.listAll,
    staleTime: 30_000,
    // Normalize `events` to an array at the data boundary so every consumer (list render + edit
    // modal) can trust the declared string[] shape. A malformed payload then renders as no tags
    // instead of taking down the whole SPA via events.map() in the ErrorBoundary.
    select: webhooks => webhooks.map(w => ({ ...w, events: Array.isArray(w.events) ? w.events : [] })),
  });
}

export function useCreateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; url: string; events: string[]; filters?: WebhookFilters | null }) =>
      webhookApi.create(params.sessionId, { url: params.url, events: params.events, filters: params.filters }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useUpdateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<Webhook> }) =>
      webhookApi.update(params.sessionId, params.id, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useDeleteWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) =>
      webhookApi.delete(params.sessionId, params.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

// ── Template Queries ─────────────────────────────────────────────────────────

export function useTemplatesQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(sessionId),
    queryFn: () => templateApi.list(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 30_000,
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; data: TemplatePayload }) =>
      templateApi.create(params.sessionId, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<TemplatePayload> }) =>
      templateApi.update(params.sessionId, params.id, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) =>
      templateApi.delete(params.sessionId, params.id),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

// ── API Key Queries ───────────────────────────────────────────────────

export function useApiKeysQuery() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: apiKeyApi.list,
    staleTime: 30_000,
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; role: string; allowedIps?: string[]; allowedSessions?: string[]; expiresAt?: string }) =>
      apiKeyApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useDeleteApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ── Logs Queries ──────────────────────────────────────────────────────

export function useLogsQuery(params: { severity?: string; page: number; limit: number }) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: () =>
      auditApi.list({
        severity: params.severity,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
      }),
    staleTime: 15_000,
  });
}

// ── Infrastructure Queries ────────────────────────────────────────────

export function useInfraStatusQuery() {
  return useQuery({
    queryKey: queryKeys.infraStatus,
    queryFn: infraApi.getStatus,
    staleTime: 30_000,
  });
}

export function useInfraConfigQuery() {
  return useQuery({
    queryKey: ['infra', 'config'],
    queryFn: infraApi.getConfig,
    staleTime: 30_000,
  });
}

// ── Plugin Queries ────────────────────────────────────────────────────

export function usePluginsQuery() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
}

export function usePluginInstancesQuery(pluginId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pluginInstances(pluginId),
    queryFn: () => pluginInstancesApi.list(pluginId),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInstanceInput) => pluginInstancesApi.create(pluginId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useRegenerateInstanceSecretMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.regenerateSecret(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useUpdateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { instanceId: string; body: UpdateInstanceInput }) =>
      pluginInstancesApi.update(pluginId, params.instanceId, params.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useDeleteInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.remove(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useEnginesQuery() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: pluginsApi.getEngines,
    staleTime: 60_000,
  });
}

export function useCurrentEngineQuery() {
  return useQuery({
    queryKey: queryKeys.currentEngine,
    queryFn: pluginsApi.getCurrentEngine,
    staleTime: 60_000,
  });
}

// ── Stats Queries ─────────────────────────────────────────────────────
// /stats/* is ADMIN-only; a non-admin key gets 403 → don't retry, let the UI fall back gracefully.

export function useStatsOverviewQuery() {
  return useQuery({
    queryKey: queryKeys.statsOverview,
    queryFn: statsApi.getOverview,
    staleTime: 30_000,
    retry: false,
  });
}

export function useStatsMessagesQuery(period: StatsPeriod) {
  return useQuery({
    queryKey: queryKeys.statsMessages(period),
    queryFn: () => statsApi.getMessages(period),
    staleTime: 30_000,
    retry: false,
  });
}
