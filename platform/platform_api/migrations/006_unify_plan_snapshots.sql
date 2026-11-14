-- Conservar la configuración aplicada de instalaciones que utilizaron P6 antes de P4.
-- Una instalación que ya usaba P4 tiene su propia copia por tenant y debe conservarla.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations legacy CROSS JOIN schema_migrations catalog
    WHERE legacy.filename = '005_audit_and_plan_config.sql'
      AND catalog.filename = '004_plans.sql'
      AND legacy.applied_at < catalog.applied_at
  ) THEN
    UPDATE plans p SET version = 2
      WHERE p.version = 1 AND EXISTS (
        SELECT 1 FROM tenants t
        WHERE t.plan = p.code AND (
          t.plan_config->'sizing' IS DISTINCT FROM p.sizing
          OR t.plan_config->'limits' IS DISTINCT FROM p.limits
        )
      );

    UPDATE tenants t SET plan_snapshot = plan_snapshot(p.code) || jsonb_build_object(
      'sizing', t.plan_config->'sizing',
      'limits', t.plan_config->'limits',
      'version', CASE WHEN t.plan_config->'sizing' = p.sizing AND t.plan_config->'limits' = p.limits
        THEN p.version ELSE 1 END
    )
    FROM plans p WHERE t.plan = p.code;
  END IF;
END
$$;

-- Mantener el destino aprobado de operaciones en curso y disponibles para reintentar.
UPDATE operations o
  SET params = (o.params - 'plan_config') || jsonb_build_object(
    'plan_snapshot', plan_snapshot(p.code) || jsonb_build_object(
      'sizing', o.params->'plan_config'->'sizing',
      'limits', o.params->'plan_config'->'limits',
      'version', CASE WHEN o.params->'plan_config'->'sizing' = p.sizing
        AND o.params->'plan_config'->'limits' = p.limits THEN p.version ELSE 1 END
    )
  )
  FROM plans p
  WHERE o.type IN ('preview-plan', 'plan-change')
    AND o.params ? 'plan_config' AND NOT o.params ? 'plan_snapshot'
    AND p.code = o.params->>'plan';

-- La cola confirma una copia congelada. Un cambio manual de código que no proporciona
-- copia todavía recibe el plan vigente, como en 004.
CREATE OR REPLACE FUNCTION tenants_plan_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.plan_snapshot := COALESCE(NEW.plan_snapshot, plan_snapshot(NEW.plan));
  ELSIF NEW.plan_snapshot IS NULL OR (
    NEW.plan IS DISTINCT FROM OLD.plan AND NEW.plan_snapshot IS NOT DISTINCT FROM OLD.plan_snapshot
  ) THEN
    NEW.plan_snapshot := plan_snapshot(NEW.plan);
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE tenants ADD CONSTRAINT tenants_plan_snapshot_matches_plan
  CHECK (plan_snapshot->>'code' IS NOT NULL AND plan_snapshot->>'code' = plan);
ALTER TABLE tenants DROP COLUMN plan_config;
