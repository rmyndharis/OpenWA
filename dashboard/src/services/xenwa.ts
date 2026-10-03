import { API_BASE_URL, type SendBulkPayload, type BulkBatchResponse, type BatchStatusResponse } from './api';

/** XenWA (XenAI Tech integration) API client: SSO hand-off, accounts, team access, billing. */

export type XenwaPermission = 'read' | 'send' | 'campaigns' | 'contacts' | 'settings';

export const PERMISSION_LABELS: Record<XenwaPermission, { label: string; hint: string }> = {
  read: { label: 'View', hint: 'See chats, messages and contacts' },
  send: { label: 'Reply', hint: 'Send messages and manage conversations' },
  campaigns: { label: 'Campaigns', hint: 'Run broadcasts / bulk sends' },
  contacts: { label: 'Contacts & templates', hint: 'Edit contacts, groups, labels and templates' },
  settings: { label: 'Settings', hint: 'Connect/disconnect, webhooks, automation, profile' },
};

export interface XenwaBillingView {
  status: 'active' | 'paused' | 'unbilled';
  paidUntil: string | null;
  creditsPerMonth: number;
  freeReason: string | null;
  lastError: string | null;
}

export interface XenwaAccount {
  sessionId: string;
  name: string | null;
  phone: string | null;
  pushName: string | null;
  status: string | null;
  role: 'owner' | 'member' | 'admin';
  permissions: XenwaPermission[];
  ownerEmail: string | null;
  billing: XenwaBillingView | null;
}

export interface XenwaMe {
  managed: boolean;
  isAdmin: boolean;
  user: { id: string; email: string; name: string | null; image: string | null; platformRole: string } | null;
  accounts: XenwaAccount[];
  limits: { maxOwnedAccounts: number };
  billing: {
    enabled: boolean;
    creditsPerNumber: number;
    graceDays: number;
    balance: number | null;
    ownedNumbers: number;
    monthlyTotal: number;
    buyCreditsUrl: string;
  };
  ssoEnabled: boolean;
  platformUrl: string;
  ssoStartUrl: string;
}

export interface XenwaPublicConfig {
  ssoEnabled: boolean;
  platformUrl: string;
  ssoStartUrl: string;
}

export interface XenwaTeamMember {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'owner' | 'member';
  permissions: XenwaPermission[];
  status: 'active' | 'pending';
  createdAt: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = sessionStorage.getItem('openwa_api_key');
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] } & T;
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    const err = new Error(msg || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

export const xenwaApi = {
  config: () => call<XenwaPublicConfig>('/xenwa/config'),
  exchange: (code: string) =>
    call<{ apiKey: string; role: string; engineType?: string }>('/xenwa/sso/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  me: () => call<XenwaMe>('/xenwa/me'),
  createAccount: (name: string) =>
    call<{ id: string; name: string; status: string }>('/xenwa/accounts', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  team: (sessionId: string) => call<XenwaTeamMember[]>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/team`),
  grant: (sessionId: string, email: string, permissions: XenwaPermission[]) =>
    call<XenwaTeamMember>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/team`, {
      method: 'POST',
      body: JSON.stringify({ email, permissions }),
    }),
  updateGrant: (sessionId: string, accessId: string, permissions: XenwaPermission[]) =>
    call<XenwaTeamMember>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/team/${encodeURIComponent(accessId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions }),
    }),
  revoke: (sessionId: string, accessId: string) =>
    call<void>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/team/${encodeURIComponent(accessId)}`, {
      method: 'DELETE',
    }),
  setOwner: (sessionId: string, email: string) =>
    call<XenwaTeamMember[]>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/owner`, {
      method: 'PUT',
      body: JSON.stringify({ email }),
    }),
  payNow: (sessionId: string) =>
    call<unknown>(`/xenwa/accounts/${encodeURIComponent(sessionId)}/billing/pay`, { method: 'POST' }),
  sendBulk: (sessionId: string, payload: SendBulkPayload) =>
    call<BulkBatchResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages/send-bulk`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  batchStatus: (sessionId: string, batchId: string) =>
    call<BatchStatusResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/messages/batch/${encodeURIComponent(batchId)}`,
    ),
  cancelBatch: (sessionId: string, batchId: string) =>
    call<BatchStatusResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/messages/batch/${encodeURIComponent(batchId)}/cancel`,
      { method: 'POST' },
    ),
};

export function can(account: XenwaAccount | undefined, permission: XenwaPermission): boolean {
  if (!account) return false;
  if (account.role === 'owner' || account.role === 'admin')
    return account.billing?.status !== 'paused' || permission === 'read';
  if (account.billing?.status === 'paused' && permission !== 'read') return false;
  return account.permissions.includes(permission);
}

export function accountLabel(a: Pick<XenwaAccount, 'pushName' | 'phone' | 'name'>): string {
  return a.pushName || (a.phone ? `+${a.phone}` : '') || a.name || 'WhatsApp number';
}

const MANAGED_FLAG = 'xenwa_managed';

/** Remembered per tab by XenwaProvider so plain helpers can branch without the React context. */
export function isXenwaManaged(): boolean {
  try {
    return sessionStorage.getItem(MANAGED_FLAG) === '1';
  } catch {
    return false;
  }
}

export function setXenwaManaged(managed: boolean): void {
  try {
    if (managed) sessionStorage.setItem(MANAGED_FLAG, '1');
    else sessionStorage.removeItem(MANAGED_FLAG);
  } catch {
    /* storage unavailable */
  }
}
