import { useEffect, useState } from 'react';
import type { PeoplePage } from '../lib/domain';
import { api } from './api';

export function usePeople({
  q = '',
  kind = '',
  state = '',
  page = 1,
  limit = 50,
  enabled = true,
  revision = 0,
}: {
  q?: string;
  kind?: string;
  /** `'deleted'` lista solo las fichas dadas de baja. */
  state?: string;
  page?: number;
  limit?: number;
  enabled?: boolean;
  revision?: number;
}) {
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const reload = (event?: Event) => {
      const topics = (event as CustomEvent | undefined)?.detail?.topics as string[] | undefined;
      if (!topics || topics.some((topic) => ['people', 'pos', 'settings', 'time'].includes(topic)))
        setRefresh((value) => value + 1);
    };
    window.addEventListener('data-reloaded', reload);
    return () => window.removeEventListener('data-reloaded', reload);
  }, []);
  const key = new URLSearchParams({ q, kind, state, page: String(page), limit: String(limit) }).toString();
  const [result, setResult] = useState<{ key: string; value: PeoplePage } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(enabled);
  useEffect(() => {
    if (!enabled) {
      setBusy(false);
      setError('');
      return;
    }
    let live = true;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      void api<PeoplePage>('people?' + key, 'GET', undefined, controller.signal)
        .then((value) => {
          if (live) setResult({ key, value });
        })
        .catch((reason) => {
          if (live && reason.name !== 'AbortError') setError(reason.message);
        })
        .finally(() => {
          if (live) setBusy(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled, revision, refresh]);
  const current = result?.key === key ? result.value : null;
  return {
    rows: enabled ? current?.rows || [] : [],
    total: enabled ? current?.total || 0 : 0,
    pageSize: limit,
    busy: enabled && (busy || (!current && !error)),
    error,
  };
}
