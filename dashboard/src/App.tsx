import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { RoleProvider, useRole, type UserRole } from './hooks/useRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const PublicDocs = lazy(() => import('./pages/PublicDocs').then(m => ({ default: m.PublicDocs })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const Users = lazy(() => import('./pages/Users').then(m => ({ default: m.Users })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const Billing = lazy(() => import('./pages/Billing').then(m => ({ default: m.Billing })));

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
  // Initialize from sessionStorage to avoid setState in effect
  const savedToken = sessionStorage.getItem('openwa_auth_token');
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedToken);
  const { setRole, role } = useRole();

  const handleLogin = async (auth: { token: string; role: UserRole; username: string }) => {
    sessionStorage.setItem('openwa_auth_token', auth.token);
    sessionStorage.removeItem('openwa_api_key');
    setRole(auth.role || 'viewer');
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setRole(null);
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.removeItem('openwa_auth_token');
  };

  // Re-validate and get role on mount if already authenticated
  useEffect(() => {
    sessionStorage.removeItem('openwa_api_key');
    const headers: HeadersInit | null = savedToken ? { Authorization: `Bearer ${savedToken}` } : null;
    if (!headers) return;

    fetch('/api/auth/validate', {
      method: 'POST',
      headers,
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid && data.role) {
          setRole(data.role as UserRole);
        } else {
          handleLogout();
        }
      })
      .catch(() => {
        // Keep existing role from localStorage if validation fails
      });
  }, [savedToken, setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/" element={<Navigate to="/login" replace />} />
            <Route path="/docs" element={<PublicDocs isAuthenticated={isAuthenticated} />} />
            <Route
              path="/login"
              element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <Login onLogin={handleLogin} />}
            />
            <Route
              element={
                isAuthenticated ? <Layout onLogout={handleLogout} userRole={role} /> : <Navigate to="/login" replace />
              }
            >
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="billing" element={<Billing />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="webhooks" element={<Webhooks />} />
            <Route path="api-keys" element={<ApiKeys />} />
              {role === 'admin' && <Route path="users" element={<Users />} />}
              <Route path="logs" element={<Logs />} />
              <Route path="message-tester" element={<MessageTester />} />
              <Route path="infrastructure" element={<Infrastructure />} />
              {role === 'admin' && <Route path="plugins" element={<Plugins />} />}
            </Route>
            <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/docs'} replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
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
