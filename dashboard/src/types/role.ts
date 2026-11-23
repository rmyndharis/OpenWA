// Role types for RBAC
export type UserRole = 'admin' | 'operator' | 'viewer';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  canWrite: boolean;
  /** Engine the gateway runs, as /auth/session reported it; null until it has answered. */
  engineType: string | null;
  setEngineType: (engineType: string | null) => void;
  /** Whether the key is restricted to selected sessions, so the cross-session routes refuse it. */
  scoped: boolean;
  setScoped: (scoped: boolean) => void;
  /** Non-secret UUID of the API key backing the active browser session; null when signed out. */
  apiKeyId?: string | null;
  setApiKeyId?: (apiKeyId: string | null) => void;
  /** Monotonic generation bumped on session rotation/re-login so live sockets reconnect even for the same apiKeyId. */
  sessionEpoch?: number;
  bumpSessionEpoch?: () => void;
}
