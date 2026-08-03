import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';
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
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    try {
      setCreating(true);
      const newSession = await sessionApi.create(newSessionName);
      setNewSessionName('');
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

  return { showCreateModal, setShowCreateModal, newSessionName, setNewSessionName, creating, handleCreate };
}
