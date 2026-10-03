import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';
import { xenwaApi, isXenwaManaged } from '../services/xenwa';
import { isValidProxyUrl } from '../utils/sessionForm';
import { useToast } from './useToast';

export interface UseSessionCreateFormArgs {
  onCreated: (session: Session) => void;
  onFailed: (message: string) => void;
}

export interface SessionCreateForm {
  showCreateModal: boolean;
  setShowCreateModal: (open: boolean) => void;
  newSessionName: string;
  setNewSessionName: (name: string) => void;
  useProxy: boolean;
  setUseProxy: (enabled: boolean) => void;
  proxyUrl: string;
  setProxyUrl: (url: string) => void;
  creating: boolean;
  handleCreate: () => Promise<void>;
}

/**
 * Owns the "New Session" modal: its open/closed state, the typed name, and the in-flight `creating`
 * flag. This is a separate feature from onboarding a session onto WhatsApp — `handleCreate` never
 * touches `qrData`/pairing state and never opens the QR modal (that's `handleStart`/`handleShowQR`).
 * Its only outward edges are the created `Session` and a failure message: the page owns appending to
 * `sessions` and invalidating the shared query cache, so this hook stays independent of that state.
 */
export function useSessionCreateForm({ onCreated, onFailed }: UseSessionCreateFormArgs): SessionCreateForm {
  const { t } = useTranslation();
  const toast = useToast();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [creating, setCreating] = useState(false);

  const resetProxyFields = () => {
    setUseProxy(false);
    setProxyUrl('');
  };

  // Anything typed into the proxy fields is dropped when the modal closes, however it closes. A
  // cancelled create otherwise leaves a credentialed URL in memory for the life of the page, and
  // prefills it the next time the modal opens.
  useEffect(() => {
    if (!showCreateModal) resetProxyFields();
  }, [showCreateModal]);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    // Guarded here rather than only on the Create button: the name field's Enter key calls this
    // directly, so a button-only check creates a session with no proxy while the toggle says on.
    if (useProxy && !isValidProxyUrl(proxyUrl.trim())) return;
    try {
      setCreating(true);
      // XenAI Tech SSO users create numbers through XenWA, which records them as the owner and
      // charges the first month from their credits; plain API keys keep the classic route.
      const newSession = isXenwaManaged()
        ? await xenwaApi.createAccount(newSessionName).then(created => sessionApi.get(created.id))
        : await sessionApi.create(
            newSessionName,
            useProxy && proxyUrl.trim() ? { proxyUrl: proxyUrl.trim() } : undefined,
          );
      setNewSessionName('');
      resetProxyFields();
      setShowCreateModal(false);
      toast.success(t('sessions.create.successTitle'), t('sessions.create.successDesc', { name: newSession.name }));
      onCreated(newSession);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.create.errorDefault');
      toast.error(t('sessions.create.errorTitle'), msg);
      onFailed(msg);
    } finally {
      setCreating(false);
    }
  };

  return {
    showCreateModal,
    setShowCreateModal,
    newSessionName,
    setNewSessionName,
    useProxy,
    setUseProxy,
    proxyUrl,
    setProxyUrl,
    creating,
    handleCreate,
  };
}
