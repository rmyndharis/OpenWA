import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { infraApi, type SaveConfigPayload } from '../services/api';
import { useToast } from './useToast';

export interface UseConfigSaveArgs {
  buildPayload: () => SaveConfigPayload;
  /**
   * Called with the profile list from a successful save and the payload it sent. One-way: this hook never reads
   * restart state. The save stays in flight until a returned promise settles.
   */
  onSaved: (profiles: string[], payload: SaveConfigPayload) => void | Promise<void>;
}

export interface ConfigSave {
  saving: boolean;
  saveConfig: () => Promise<void>;
}

/**
 * Owns the save-configuration request: the in-flight `saving` flag and the two failure toasts. Hands
 * the new profile list to `onSaved` instead of driving the restart modal directly, so the edge to the
 * restart flow stays one-way.
 */
export function useConfigSave({ buildPayload, onSaved }: UseConfigSaveArgs): ConfigSave {
  const { t } = useTranslation();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      const result = await infraApi.saveConfig(payload);
      if (result.saved) {
        await onSaved(result.profiles || [], payload);
      } else {
        toast.error(t('infrastructure.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

  return { saving, saveConfig };
}
