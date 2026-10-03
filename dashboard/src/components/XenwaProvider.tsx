import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { xenwaApi, setXenwaManaged, type XenwaMe } from '../services/xenwa';

interface XenwaContextValue {
  me: XenwaMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const XenwaContext = createContext<XenwaContextValue>({ me: null, loading: false, refresh: async () => {} });

/**
 * Who is signed in to XenWA and what they may do on each WhatsApp number. `me.managed` is true for
 * XenAI Tech SSO users; plain API-key logins (legacy admin keys) get managed=false and keep the
 * classic gateway UI.
 */
export function XenwaProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<XenwaMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await xenwaApi.me();
      setXenwaManaged(next.managed && !next.isAdmin);
      setMe(next);
    } catch {
      setXenwaManaged(false);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <XenwaContext.Provider value={{ me, loading, refresh }}>{children}</XenwaContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useXenwa(): XenwaContextValue {
  return useContext(XenwaContext);
}
