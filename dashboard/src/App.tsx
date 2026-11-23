import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { NumberCheckProvider } from './components/NumberCheckProvider';
import { useRole } from './hooks/useRole';
import { RoleProvider } from './components/RoleProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { authApi } from './services/api';
import type { LoginSessionResult } from './pages/Login';
import {
  broadcastAuthEvent,
  clearActorState,
  clearLegacyApiKeyStorage,
  clearSessionMetadata,
  getActiveApiKeyId,
  isUserRole,
  resolveStartupValidation,
  subscribeAuthEvents,
} from './utils/authLifecycle';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const NumberChecker = lazy(() => import('./pages/NumberChecker').then(m => ({ default: m.NumberChecker })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Clear any legacy plaintext API key left in sessionStorage by older builds, and read the
  // non-secret session actor id once at mount so we know whether to render optimistically while
  // GET /auth/session hydrates live state from the HttpOnly browser session cookie.
  const [hadSavedSession] = useState(() => {
    clearLegacyApiKeyStorage();
    return Boolean(getActiveApiKeyId());
  });
  const [isAuthenticated, setIsAuthenticated] = useState(hadSavedSession);
  const [hydratingSession, setHydratingSession] = useState(!hadSavedSession);
  const authGenRef = useRef(0);
  const { setRole, role, setEngineType, setScoped, scoped, setApiKeyId, bumpSessionEpoch } = useRole();

  const clearLocalSession = useCallback(() => {
    setIsAuthenticated(false);
    setHydratingSession(false);
    setRole(null);
    setEngineType(null);
    setScoped(false);
    setApiKeyId?.(null);
    clearSessionMetadata();
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout -> login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [setRole, setEngineType, setScoped, setApiKeyId]);

  const handleLogin = useCallback(
    (session: LoginSessionResult) => {
      authGenRef.current += 1;
      clearLegacyApiKeyStorage();
      const effectiveApiKeyId = session.apiKeyId ?? 'session';
      // The login page's POST /auth/session response already carried the role, scope, engine, and
      // apiKeyId, so no second round-trip is needed. An absent or unrecognized role falls back to
      // viewer, the least-privileged default.
      setRole(isUserRole(session.role) ? session.role : 'viewer');
      setEngineType(session.engineType ?? null);
      setScoped(session.scoped === true);
      setApiKeyId?.(effectiveApiKeyId);
      setHydratingSession(false);
      setIsAuthenticated(true);
      broadcastAuthEvent({ type: 'login', apiKeyId: effectiveApiKeyId });
    },
    [setRole, setEngineType, setScoped, setApiKeyId],
  );

  const handleLogout = useCallback(() => {
    authGenRef.current += 1;
    clearLocalSession();
    broadcastAuthEvent({ type: 'logout' });
    void authApi.deleteSession().catch(() => undefined);
  }, [clearLocalSession]);

  const hydrateFromServer = useCallback(
    (clearOnFailure: boolean, refreshSocket = false) => {
      const gen = ++authGenRef.current;

      authApi
        .getSession()
        .then(async res => {
          const decision = resolveStartupValidation(res.status, await res.json().catch(() => null));
          // Ignore stale answers if the user already logged in or logged out while hydration was in flight.
          if (authGenRef.current !== gen) return;
          if (decision.action === 'logout') {
            if (clearOnFailure) {
              clearLocalSession();
            } else {
              setHydratingSession(false);
            }
          } else if (decision.action === 'role') {
            setRole(decision.role);
            setScoped(decision.scoped);
            if (decision.engineType) setEngineType(decision.engineType);
            if (decision.apiKeyId) setApiKeyId?.(decision.apiKeyId);
            else if (!getActiveApiKeyId()) setApiKeyId?.('session');
            setHydratingSession(false);
            setIsAuthenticated(true);
            if (refreshSocket) bumpSessionEpoch?.();
          } else {
            setHydratingSession(false);
          }
        })
        .catch(() => {
          if (authGenRef.current !== gen) return;
          // Network failure (API unreachable): keep an already-hydrated session so a transient outage
          // at page reload doesn't eject the user, while an unauthenticated tab falls through to Login.
          setHydratingSession(false);
        });
    },
    [setRole, setEngineType, setScoped, setApiKeyId, bumpSessionEpoch, clearLocalSession],
  );

  // Hydrate and refresh the active browser session once at mount (covers both page reload and a
  // newly opened tab sharing the browser's HttpOnly session cookie).
  useEffect(() => {
    hydrateFromServer(hadSavedSession);
  }, [hadSavedSession, hydrateFromServer]);

  // Keep sibling tabs aligned on secret-free logout/login broadcasts (never sending secrets).
  useEffect(() => {
    return subscribeAuthEvents(event => {
      if (event.type === 'logout') {
        authGenRef.current += 1;
        clearLocalSession();
        return;
      }
      if (event.type === 'login') {
        // Always re-hydrate and reconnect sockets even when apiKeyId matches, because
        // POST /api/auth/session rotates and revokes the prior cookie session.
        clearActorState(queryClient);
        hydrateFromServer(true, true);
      }
    });
  }, [clearLocalSession, hydrateFromServer]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (hydratingSession) {
    return loadingFallback;
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        <Login onLogin={handleLogin} />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      {/* Above the routes, so a bulk Number Checker run survives leaving its page; a logout unmounts it. */}
      <NumberCheckProvider>
        <BrowserRouter>
          <Suspense fallback={loadingFallback}>
            <Routes>
              <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
                <Route index element={<Dashboard />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="chats" element={<Chats />} />
                <Route path="number-checker" element={<NumberChecker />} />
                <Route path="webhooks" element={<Webhooks />} />
                <Route path="templates" element={<Templates />} />
                {role === 'admin' && !scoped && <Route path="api-keys" element={<ApiKeys />} />}
                {role === 'admin' && <Route path="logs" element={<Logs />} />}
                <Route path="message-tester" element={<MessageTester />} />
                {role === 'admin' && !scoped && <Route path="infrastructure" element={<Infrastructure />} />}
                {role === 'admin' && !scoped && <Route path="plugins" element={<Plugins />} />}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </NumberCheckProvider>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
