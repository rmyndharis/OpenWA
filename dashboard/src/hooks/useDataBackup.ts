import { useEffect, useRef, useState } from 'react';
import { shouldOfferStopOrphansRetry } from '../utils/importRefusal';
import { keepsSameKey } from '../utils/authLifecycle';
import { useTranslation } from 'react-i18next';
import { infraApi } from '../services/api';
import { useToast } from './useToast';

export interface DataBackup {
  migrating: boolean;
  exportBackup: () => Promise<void>;
  importBackup: (file: File) => Promise<void>;
}

/**
 * Owns the data-migration flows used around a database/storage backend switch (#488): exporting a
 * full JSON dump (call before switching, while still on the old backend) and importing one back
 * (replaces all current data), including the 409 stop-orphans confirm/retry.
 */
export function useDataBackup(): DataBackup {
  const { t } = useTranslation();
  const toast = useToast();
  const [migrating, setMigrating] = useState(false);
  const importOwnerRef = useRef<object | null>(null);

  useEffect(() => {
    importOwnerRef.current = {};
    return () => {
      importOwnerRef.current = null;
    };
  }, []);

  // Download a JSON backup of all Data-DB tables. Called BEFORE a DB switch (while still on the old
  // database) so the data can be re-imported into the new one — switching otherwise starts empty (#488).
  const exportBackup = async () => {
    setMigrating(true);
    const sameKey = keepsSameKey();
    try {
      const dump = await infraApi.exportData();
      // The dump holds every integration instance's secrets in plaintext: not for a signed-out page.
      if (!sameKey()) return;
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openwa-backup-${dump.exportedAt?.slice(0, 10) || 'data'}.json`;
      a.click();
      URL.revokeObjectURL(url);

      // The download itself is silent on success, which is fine when the backup is complete. It is
      // not fine when the budget dropped media: the archive restores without error and nothing else
      // would ever tell the operator that some history came back without its attachments.
      const omitted = dump.omittedInlineMedia;
      const dropped = (omitted?.messages ?? 0) + (omitted?.messageBatches ?? 0);
      if (dropped > 0) {
        toast.warning(
          t('infrastructure.migration.exportPartialTitle'),
          t('infrastructure.migration.exportPartial', { count: dropped }),
        );
      }
    } catch (err) {
      toast.error(
        t('infrastructure.migration.exportFailed'),
        err instanceof Error ? err.message : t('common.unknownError'),
      );
    } finally {
      setMigrating(false);
    }
  };

  // POST the replace-all restore and fold the backend's orphan-engine contract into the UI. The route
  // answers 409 for several different reasons and they need opposite handling, so branch on the
  // machine code, never on the status alone. Only IMPORT_WOULD_ORPHAN_ENGINES is a decision — live
  // engines exist for sessions the backup would remove — and its preferred retry is stopOrphans=true,
  // which stops them inside the request, so that one is offered as a confirm. Every other 409 leaves
  // nothing to decide (another restore in flight, another transaction holding the connection), and
  // retrying one with stopOrphans would run a second destructive replace the operator never asked
  // for. force=true is deliberately not offered (the api client does not even send it): it leaves
  // the engines running until a restart.
  const runImport = async (
    tables: Record<string, unknown[]>,
    isCurrent: () => boolean,
    sameKey: () => boolean,
    stopOrphans = false,
  ): Promise<void> => {
    if (!isCurrent()) return;
    try {
      const res = await infraApi.importData(tables, stopOrphans ? { stopOrphans: true } : undefined);
      // The replace has run: its outcome is reported wherever the operator is now, unless another key took over.
      if (!sameKey()) return;
      if (res.imported) {
        // notices carry non-fatal operator messages (orphan teardown details); restartRequired
        // means a teardown failed and only a restart guarantees cleanup — surface both on success.
        if (res.restartRequired || (res.notices && res.notices.length > 0)) {
          toast.warning(t('infrastructure.migration.importOk'), (res.notices ?? []).join('; ') || undefined);
        } else {
          toast.success(t('infrastructure.migration.importOk'));
        }
      } else {
        toast.error(
          t('infrastructure.migration.importFailed'),
          (res.warnings || []).slice(0, 3).join('; ') || res.message,
        );
      }
    } catch (err) {
      if (!sameKey()) return;
      const status = (err as { status?: number } | null)?.status;
      const code = (err as { code?: string } | null)?.code;
      if (shouldOfferStopOrphansRetry(status, code, stopOrphans) && err instanceof Error) {
        // The confirm doubles as the refusal display: OK retries with stopOrphans=true, Cancel
        // leaves the engines (and the current data) untouched. A 409 on the retry itself (an
        // engine started mid-import) falls through to the plain error toast — no confirm loop.
        // Not put to an operator who has left the page: the refusal is reported and nothing is stopped.
        if (!isCurrent()) {
          toast.error(t('infrastructure.migration.importFailed'), err.message);
          return;
        }
        const retry = window.confirm(err.message);
        if (!isCurrent()) return;
        if (retry) await runImport(tables, isCurrent, sameKey, true);
        else toast.error(t('infrastructure.migration.importFailed'), err.message);
        return;
      }
      // A large backup can exceed the request body cap (default 25mb) — give an actionable message
      // instead of a bare "Payload Too Large". The status is carried on the Error by the api client.
      const detail =
        status === 413
          ? t('infrastructure.migration.importTooLarge')
          : err instanceof Error
            ? err.message
            : t('common.unknownError');
      toast.error(t('infrastructure.migration.importFailed'), detail);
    }
  };

  // Restore a previously-exported backup into the CURRENT database (use after switching + restart).
  // Import REPLACES all current data, so validate + confirm (showing the row count) before any call.
  const importBackup = async (file: File) => {
    if (!sessionStorage.getItem('openwa_api_key') || importOwnerRef.current === null) return;
    // A newer selection or an unmount retires what has not been sent yet, including a delayed refusal retry.
    const owner = {};
    importOwnerRef.current = owner;
    const sameKey = keepsSameKey();
    const isCurrent = () => importOwnerRef.current === owner && sameKey();
    setMigrating(true);
    try {
      let parsed: { tables?: Record<string, unknown[]> };
      try {
        const text = await file.text();
        if (!isCurrent()) return;
        parsed = JSON.parse(text) as { tables?: Record<string, unknown[]> };
      } catch {
        if (isCurrent()) {
          toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
        }
        return;
      }
      if (!isCurrent()) return;
      if (!parsed?.tables || typeof parsed.tables !== 'object') {
        toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
        return;
      }
      const rows = Object.values(parsed.tables).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
      if (!window.confirm(t('infrastructure.migration.importConfirm', { rows })) || !isCurrent()) return;
      await runImport(parsed.tables, isCurrent, sameKey);
    } finally {
      if (importOwnerRef.current === owner) setMigrating(false);
    }
  };

  return { migrating, exportBackup, importBackup };
}
