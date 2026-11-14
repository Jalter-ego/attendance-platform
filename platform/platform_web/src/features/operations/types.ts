export interface Operation {
  id: string;
  tenant_id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: string;
  progress: number;
  cancel_requested: boolean;
  error_message: string | null;
  created_at: string;
}

export interface OperationEvent {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  created_at: string;
}

export const operationLabels: Record<string, string> = {
  diagnostic: 'Diagnóstico de integración',
  backup: 'Respaldo',
  restore: 'Restauración',
  create: 'Creación de infraestructura',
  suspend: 'Suspensión',
  resume: 'Reanudación',
  destroy: 'Eliminación',
};
