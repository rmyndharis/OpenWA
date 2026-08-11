import { useState } from 'react';
import { shouldOfferStopOrphansRetry } from '../utils/importRefusal';
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

  // Download a JSON backup of all Data-DB tables. Called BEFORE a DB switch (while still on the old
  // database) so the data can be re-imported into the new one — switching otherwise starts empty (#488).
  const exportBackup = async () => {
    setMigrating(true);
    try {
      const dump = await infraApi.exportData();
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
  const runImport = async (tables: Record<string, unknown[]>, stopOrphans = false): Promise<void> => {
    try {
      const res = await infraApi.importData(tables, stopOrphans ? { stopOrphans: true } : undefined);
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
      const status = (err as { status?: number } | null)?.status;
      const code = (err as { code?: string } | null)?.code;
      if (shouldOfferStopOrphansRetry(status, code, stopOrphans) && err instanceof Error) {
        // The confirm doubles as the refusal display: OK retries with stopOrphans=true, Cancel
        // leaves the engines (and the current data) untouched. A 409 on the retry itself (an
        // engine started mid-import) falls through to the plain error toast — no confirm loop.
        if (window.confirm(err.message)) await runImport(tables, true);
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
    let parsed: { tables?: Record<string, unknown[]> };
    try {
      parsed = JSON.parse(await file.text()) as { tables?: Record<string, unknown[]> };
    } catch {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    if (!parsed?.tables || typeof parsed.tables !== 'object') {
      toast.error(t('infrastructure.migration.importFailed'), t('infrastructure.migration.invalidFile'));
      return;
    }
    const rows = Object.values(parsed.tables).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    if (!window.confirm(t('infrastructure.migration.importConfirm', { rows }))) return;
    setMigrating(true);
    try {
      await runImport(parsed.tables);
    } finally {
      setMigrating(false);
    }
  };

  return { migrating, exportBackup, importBackup };
}
