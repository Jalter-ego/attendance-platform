-- Converger desde 003 de P2, 003 de P6 o una instalación nueva, sin cambiar
-- los archivos ya aplicados ni descartar recursos, eventos o versiones.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
UPDATE deployments d SET status=CASE
  WHEN o.status <> 'succeeded' THEN 'failed'
  WHEN o.type='suspend' THEN 'suspended'
  WHEN o.type='destroy' THEN 'deleted'
  ELSE 'ready' END
FROM operations o WHERE d.operation_id=o.id AND d.status='succeeded';
UPDATE deployments SET status='ready' WHERE status='succeeded';
ALTER TABLE deployments ALTER COLUMN status SET DEFAULT 'ready';
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('provisioning', 'ready', 'suspended', 'deleted', 'failed'));
UPDATE deployments SET log_ref='operations/' || operation_id::text WHERE log_ref IS NULL;
