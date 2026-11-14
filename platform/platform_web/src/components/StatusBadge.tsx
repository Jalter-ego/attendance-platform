const labels: Record<string, string> = {
  draft: 'Sin desplegar',
  provisioning: 'Creando',
  ready: 'Disponible',
  suspending: 'Suspendiendo',
  suspended: 'Suspendida',
  resuming: 'Reanudando',
  deleting: 'Eliminando',
  deleted: 'Eliminada',
  failed: 'Fallida',
  queued: 'En cola',
  running: 'En curso',
  succeeded: 'Completada',
  cancelled: 'Cancelada',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = ['ready', 'succeeded'].includes(status)
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : [
            'queued',
            'running',
            'provisioning',
            'resuming',
            'suspending',
            'deleting',
          ].includes(status)
        ? 'progress'
        : 'neutral';
  return (
    <span className="status-badge" data-tone={tone}>
      <span />
      {labels[status] || status}
    </span>
  );
}
