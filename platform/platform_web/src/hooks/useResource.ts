import { useEffect, useState } from 'react';

export function useResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs = 0,
) {
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: string | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const data = await fetcher(controller.signal);
        if (!controller.signal.aborted) setResult({ key, data, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            key,
            data: previous?.key === key ? previous.data : null,
            error:
              error instanceof Error
                ? error.message
                : 'No se pudieron cargar los datos.',
          }));
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = intervalMs ? window.setInterval(load, intervalMs) : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [key, fetcher, intervalMs, revision]);
  return {
    data: result?.key === key ? result.data : null,
    error: result?.key === key ? result.error : null,
    loading: result?.key !== key,
    reload: () => setRevision((value) => value + 1),
  };
}
