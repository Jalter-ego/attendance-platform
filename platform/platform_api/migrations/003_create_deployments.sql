-- P6: creación real mediante el adaptador de P2; conservar backup/restore de P3.
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore', 'create'));

ALTER TABLE deployments ADD COLUMN status varchar(20) NOT NULL DEFAULT 'ready'
  CHECK (status IN ('provisioning', 'ready', 'failed'));
ALTER TABLE deployments ADD COLUMN health jsonb NOT NULL DEFAULT '{}';
