import { useEffect, useRef, useState } from 'react';
import { operationsService } from '../services/operations.service';
import { operationLabels } from '../types';
import type { Operation, OperationEvent } from '../types';
import { StatusBadge } from '../../../components/StatusBadge';
import { useAuth } from '../../auth/hooks/useAuth';

export function OperationPanel({
  id,
  onRetry,
}: {
  id: string;
  onRetry: (operation: Operation) => void;
}) {
  const { user } = useAuth();
  const [view, setView] = useState<{
    id: string;
    operation: Operation;
    events: OperationEvent[];
  } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const logConsoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cursor = '0';
    const events: OperationEvent[] = [];
    let timer: number | undefined;
    async function poll() {
      let active = true;
      try {
        const operation = await operationsService.get(id, controller.signal);
        let more: boolean;
        do {
          const page = await operationsService.logs(
            id,
            cursor,
            controller.signal,
          );
          events.push(...page.items);
          cursor = page.next_cursor;
          more = page.has_more;
        } while (more && !controller.signal.aborted);
        if (!controller.signal.aborted) {
          setView({ id, operation, events: [...events] });
          setError('');
        }
        active = ['queued', 'running'].includes(operation.status);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'No se pudo consultar la operación.',
          );
      }
      if (!controller.signal.aborted && active)
        timer = window.setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, revision]);
  const operation = view?.id === id ? view.operation : null;
  const lastEventId = view?.id === id ? view.events[view.events.length - 1]?.id : undefined;
  useEffect(() => {
    const logConsole = logConsoleRef.current;
    if (logConsole) logConsole.scrollTop = logConsole.scrollHeight;
  }, [id, lastEventId]);

  async function action(kind: 'cancel' | 'retry') {
    setPending(true);
    setError('');
    try {
      const result = await operationsService[kind](id);
      if (kind === 'retry') onRetry(result);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'No se pudo completar la acción.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="panel operation-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">OPERACIÓN</span>
          <h2>
            {operation
              ? (operationLabels[operation.type] ?? operation.type)
              : 'Operación'}
          </h2>
        </div>
        {operation && <StatusBadge status={operation.status} />}
      </div>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {operation ? (
        <>
          <div className="progress-label">
            <span>{operation.stage}</span>
            <strong>{operation.progress}%</strong>
          </div>
          <progress
            aria-label="Progreso de la operación"
            value={operation.progress}
            max={100}
          />
          <div
            ref={logConsoleRef}
            className="log-console"
            role="log"
            aria-label="Eventos de la operación"
          >
            {view?.events.map((event) => (
              <div key={event.id} className={`log-line ${event.level}`}>
                <time>
                  {new Date(event.created_at).toLocaleTimeString('es-BO')}
                </time>
                <span>{event.message}</span>
              </div>
            ))}
          </div>
          {operation.error_message && (
            <p className="alert error">{operation.error_message}</p>
          )}
          {user?.role === 'platform_admin' && (
            <div className="operation-actions">
              {['queued', 'running'].includes(operation.status) && (
                <button
                  className="button small"
                  disabled={pending || operation.cancel_requested}
                  onClick={() => {
                    void action('cancel');
                  }}
                >
                  {operation.cancel_requested
                    ? 'Cancelación solicitada'
                    : 'Cancelar operación'}
                </button>
              )}
              {['failed', 'cancelled'].includes(operation.status) && !operation.type.startsWith('preview-') && (
                <button
                  className="button small"
                  disabled={pending}
                  onClick={() => {
                    void action('retry');
                  }}
                >
                  Reintentar
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="loading-text">Cargando operación…</p>
      )}
    </section>
  );
}
