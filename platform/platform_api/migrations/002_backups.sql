-- P3: respaldos y restauraciones como operaciones de la cola (mismo bloqueo por tenant,
-- eventos, cancelación y reintento). Si otra migración agrega tipos, debe incluir estos.
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore'));

-- Entrada de la operación (p. ej. {"backup_id": "..."} al restaurar) y resultado JSON del
-- ejecutor (última línea de tenant-backup.sh). Ninguno guarda secretos.
ALTER TABLE operations ADD COLUMN params jsonb NOT NULL DEFAULT '{}';
ALTER TABLE operations ADD COLUMN result jsonb;
