-- P2: operaciones de infraestructura ejecutadas por los adaptadores de motor (EngineAdapter).
-- Conserva los tipos anteriores (diagnóstico de P6 y respaldos de P3). Si otra migración
-- agrega tipos, debe incluir todos estos.
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore', 'create', 'suspend', 'resume', 'destroy'));

-- Resultado de cada despliegue: estado final y referencia a los eventos de la operación.
-- outputs/resources/tool_versions ya existen desde 001; ninguno guarda secretos.
ALTER TABLE deployments ADD COLUMN status varchar(20) NOT NULL DEFAULT 'succeeded';
ALTER TABLE deployments ADD COLUMN log_ref varchar(100);
