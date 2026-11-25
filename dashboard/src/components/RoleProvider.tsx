import { useState, useCallback, useMemo, type ReactNode } from 'react';
import type { UserRole, RoleContextType } from '../types/role';
import { RoleContext } from '../hooks/useRole';
import {
  DENIED_PERMISSIONS_STORAGE_KEY,
  getActiveApiKeyId,
  normalizeDeniedPermissions,
  setActiveApiKeyId,
} from '../utils/authLifecycle';

export function RoleProvider({ children }: { children: ReactNode }) {
  // Per tab, next to the active session actor id it was hydrated for: a role outliving its session
  // (or shared with another tab signed in as a different actor) would gate the UI for the wrong role.
  const [role, setRoleState] = useState<UserRole | null>(() => {
    // Older builds kept the role in localStorage, shared by every tab. A tab that already holds an
    // active session id but no role of its own adopts that copy until GET /auth/session answers.
    const legacy = localStorage.getItem('openwa_user_role');
    if (legacy && !sessionStorage.getItem('openwa_user_role') && getActiveApiKeyId()) {
      sessionStorage.setItem('openwa_user_role', legacy);
    }
    const saved = sessionStorage.getItem('openwa_user_role');
    return (saved as UserRole) || null;
  });

  const setRole = useCallback((newRole: UserRole | null) => {
    setRoleState(newRole);
    if (newRole) {
      sessionStorage.setItem('openwa_user_role', newRole);
    } else {
      sessionStorage.removeItem('openwa_user_role');
    }
  }, []);

  // Kept beside the role because GET /infra/engines/current is admin-only: the session response is
  // the one place every role learns which engine it is talking to.
  const [engineType, setEngineTypeState] = useState<string | null>(() => sessionStorage.getItem('openwa_engine_type'));

  const setEngineType = useCallback((newEngineType: string | null) => {
    setEngineTypeState(newEngineType);
    if (newEngineType) {
      sessionStorage.setItem('openwa_engine_type', newEngineType);
    } else {
      sessionStorage.removeItem('openwa_engine_type');
    }
  }, []);

  // Session-scoped keys are refused on the cross-session routes (e.g. /stats/overview) whatever their
  // role, so the UI needs the scope beside the role to avoid sending them.
  const [scoped, setScopedState] = useState(() => sessionStorage.getItem('openwa_key_scoped') === 'true');

  const setScoped = useCallback((newScoped: boolean) => {
    setScopedState(newScoped);
    if (newScoped) {
      sessionStorage.setItem('openwa_key_scoped', 'true');
    } else {
      sessionStorage.removeItem('openwa_key_scoped');
    }
  }, []);

  const [apiKeyId, setApiKeyIdState] = useState<string | null>(() => getActiveApiKeyId());

  const [deniedPermissions, setDeniedPermissionsState] = useState<string[]>(() => {
    try {
      return normalizeDeniedPermissions(JSON.parse(sessionStorage.getItem(DENIED_PERMISSIONS_STORAGE_KEY) ?? '[]'));
    } catch {
      return [];
    }
  });

  const setDeniedPermissions = useCallback((permissions: readonly string[]) => {
    const normalized = normalizeDeniedPermissions(permissions);
    setDeniedPermissionsState(normalized);
    if (normalized.length > 0) {
      sessionStorage.setItem(DENIED_PERMISSIONS_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      sessionStorage.removeItem(DENIED_PERMISSIONS_STORAGE_KEY);
    }
  }, []);

  const isCapabilityDenied = useCallback(
    (capability: string) => deniedPermissions.includes(capability),
    [deniedPermissions],
  );

  const setApiKeyId = useCallback((newApiKeyId: string | null) => {
    setApiKeyIdState(newApiKeyId);
    setActiveApiKeyId(newApiKeyId);
  }, []);

  const [sessionEpoch, setSessionEpoch] = useState(0);
  const bumpSessionEpoch = useCallback(() => {
    setSessionEpoch(epoch => epoch + 1);
  }, []);

  const value = useMemo<RoleContextType>(
    () => ({
      role,
      setRole,
      isAdmin: role === 'admin',
      isOperator: role === 'operator',
      isViewer: role === 'viewer',
      canWrite: role === 'admin' || role === 'operator',
      deniedPermissions,
      setDeniedPermissions,
      isCapabilityDenied,
      engineType,
      setEngineType,
      scoped,
      setScoped,
      apiKeyId,
      setApiKeyId,
      sessionEpoch,
      bumpSessionEpoch,
    }),
    [
      role,
      setRole,
      deniedPermissions,
      setDeniedPermissions,
      isCapabilityDenied,
      engineType,
      setEngineType,
      scoped,
      setScoped,
      apiKeyId,
      setApiKeyId,
      sessionEpoch,
      bumpSessionEpoch,
    ],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
