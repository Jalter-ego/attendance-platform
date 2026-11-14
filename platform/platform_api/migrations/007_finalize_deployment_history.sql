-- Repara instalaciones que aplicaron la compatibilidad de PR #26 después de
-- haber unificado los tipos de P6. Conserva todos los eventos y operaciones.
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore', 'create', 'suspend', 'resume',
                  'destroy', 'upgrade', 'plan-change', 'delete', 'preview-plan', 'preview-delete'));

-- Los despliegues anteriores de P6 guardaban salud en outputs y usaban
-- el estado por defecto de la columna, incluido para la eliminación.
UPDATE deployments
   SET health = outputs->'health'
 WHERE health = '{}'::jsonb AND jsonb_typeof(outputs->'health') = 'object';

UPDATE deployments
   SET log_ref = 'operations/' || operation_id::text
 WHERE log_ref IS NULL AND operation_id IS NOT NULL;

UPDATE deployments d
   SET status = CASE WHEN o.type = 'suspend' THEN 'suspended' ELSE 'deleted' END
  FROM operations o
 WHERE d.operation_id = o.id AND d.status = 'ready' AND o.status = 'succeeded'
   AND o.type IN ('suspend', 'delete', 'destroy');
