-- Unifica los tipos de P2 y del panel local de P6 sin cambiar las migraciones 003.
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore', 'create', 'suspend', 'resume',
                  'destroy', 'upgrade', 'plan-change', 'delete', 'preview-plan', 'preview-delete'));
