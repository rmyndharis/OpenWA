import { useCallback, useEffect, useState } from 'react';
import type { QuickReplyInput } from '../services/api';

const STORAGE_KEY = 'openwa_quick_replies';

export interface LocalQuickReply extends Required<Pick<QuickReplyInput, 'id' | 'shortcut' | 'message'>> {
  keywords: string[];
}

type Store = Record<string, LocalQuickReply[]>; // sessionId -> quick replies

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/**
 * Baileys has no "list all quick replies" API (mirrors the backend quick-reply module, which only
 * exposes create/edit + delete-by-id). This hook remembers what THIS browser has created, purely
 * client-side, so the Quick Replies page can show/edit/delete them. A quick reply created outside
 * this browser (or on another device) will not appear here — that is a real limitation, not a bug.
 */
export function useLocalQuickReplies(sessionId: string) {
  const [items, setItems] = useState<LocalQuickReply[]>(() => readStore()[sessionId] ?? []);

  useEffect(() => {
    setItems(readStore()[sessionId] ?? []);
  }, [sessionId]);

  const save = useCallback(
    (quickReply: LocalQuickReply) => {
      const store = readStore();
      const existing = store[sessionId] ?? [];
      const next = existing.some(q => q.id === quickReply.id)
        ? existing.map(q => (q.id === quickReply.id ? quickReply : q))
        : [...existing, quickReply];
      store[sessionId] = next;
      writeStore(store);
      setItems(next);
    },
    [sessionId],
  );

  const remove = useCallback(
    (id: string) => {
      const store = readStore();
      const next = (store[sessionId] ?? []).filter(q => q.id !== id);
      store[sessionId] = next;
      writeStore(store);
      setItems(next);
    },
    [sessionId],
  );

  return { items, save, remove };
}