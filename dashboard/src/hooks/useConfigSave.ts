import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { infraApi, type SaveConfigPayload } from '../services/api';
import { useToast } from './useToast';

export interface UseConfigSaveArgs {
  buildPayload: () => SaveConfigPayload;
  /** Called with the profile list from a successful save. One-way: this hook never reads restart state. */
  onSaved: (profiles: string[]) => void;
}

export interface ConfigSave {
  saving: boolean;
  savePending: boolean;
  saveConfig: () => Promise<void>;
}

/**
 * Owns the save-configuration request: the in-flight `saving` flag, `savePending` (set once a save
 * succeeds; only a full page reload from a completed restart clears it — see Infrastructure.tsx's
 * envPinNote logic), and the two failure toasts. Hands the new profile list to `onSaved` instead of
 * driving the restart modal directly, so the edge to the restart flow stays one-way.
 */
export function useConfigSave({ buildPayload, onSaved }: UseConfigSaveArgs): ConfigSave {
  const { t } = useTranslation();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [savePending, setSavePending] = useState(false);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const result = await infraApi.saveConfig(buildPayload());
      if (result.saved) {
        setSavePending(true);
        onSaved(result.profiles || []);
      } else {
        toast.error(t('infrastructure.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

  return { saving, savePending, saveConfig };
}
