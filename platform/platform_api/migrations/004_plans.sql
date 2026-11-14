-- P4 (F1/F3, RF-01/02/04): catálogo de planes completo y copia del plan en cada tenant.
--
-- Un plan define cómputo y disco (sizing), límites de uso de la app (limits → PLAN_MAX_* en
-- attendance-core) y respaldo (backup). Editar un plan sube su versión y NO cambia los tenants
-- existentes: cada tenant guarda en plan_snapshot el plan con el que se creó, y los motores usan
-- esa copia. Sin ella, el siguiente suspend/resume aplicaría los límites nuevos, cambiaría el
-- user_data y recrearía las EC2 del tenant (user_data_replace_on_change del módulo de P1).

ALTER TABLE plans ADD COLUMN description varchar(300) NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN backup jsonb NOT NULL DEFAULT '{"schedule": "weekly", "retention_days": 28}';
ALTER TABLE plans ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE plans ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE plans ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE plans ADD COLUMN updated_by uuid REFERENCES users(id);

-- Semilla (F3): textos del wizard y respaldo que hasta ahora estaba fijo en el código
-- (BACKUP_BY_PLAN de engines/tenant-input.js).
UPDATE plans SET description = 'Para instituciones pequeñas',
  backup = '{"schedule": "weekly", "retention_days": 28}' WHERE code = 'basic';
UPDATE plans SET description = 'Para instituciones en crecimiento',
  backup = '{"schedule": "daily", "retention_days": 14}' WHERE code = 'standard';
UPDATE plans SET description = 'Para alta demanda',
  backup = '{"schedule": "daily", "retention_days": 30}' WHERE code = 'advanced';

-- Red de seguridad con las mismas reglas que infra/terraform/tenant/variables.tf; la API valida
-- antes con mensajes legibles (plans.service.js).
ALTER TABLE plans ADD CONSTRAINT plans_code_format
  CHECK (code ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$');
-- (Un CHECK deja pasar NULL: por eso se exige primero que existan las claves.)
ALTER TABLE plans ADD CONSTRAINT plans_sizing_allowed CHECK (
  sizing ?& ARRAY['frontend', 'backend', 'db', 'db_disk_gb']
  AND sizing->>'frontend' IN ('t3.micro', 't3.small', 't3.medium', 't3.large')
  AND sizing->>'backend' IN ('t3.micro', 't3.small', 't3.medium', 't3.large')
  AND sizing->>'db' IN ('t3.micro', 't3.small', 't3.medium', 't3.large')
  AND jsonb_typeof(sizing->'db_disk_gb') = 'number'
  AND (sizing->>'db_disk_gb')::numeric >= 10
  AND (sizing->>'db_disk_gb')::numeric = trunc((sizing->>'db_disk_gb')::numeric)
);
ALTER TABLE plans ADD CONSTRAINT plans_backup_allowed CHECK (
  backup ?& ARRAY['schedule', 'retention_days']
  AND (backup->>'schedule', backup->>'retention_days') IN (('weekly', '28'), ('daily', '14'), ('daily', '30'))
);
-- limits: solo las claves que lee boot_backend (PLAN_MAX_*), enteros positivos. Vacío = sin límites.
ALTER TABLE plans ADD CONSTRAINT plans_limits_valid CHECK (
  jsonb_typeof(limits) = 'object'
  AND limits - ARRAY['max_students', 'max_teachers', 'max_courses'] = '{}'::jsonb
  AND NOT jsonb_path_exists(limits, '$.* ? (@.type() != "number" || @ < 1 || @ != @.floor())')
);

-- Copia del plan en el tenant: {code, name, version, sizing, limits, backup}.
ALTER TABLE tenants ADD COLUMN plan_snapshot jsonb;

CREATE FUNCTION plan_snapshot(plan_code varchar) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('code', code, 'name', name, 'version', version,
                            'sizing', sizing, 'limits', limits, 'backup', backup)
  FROM plans WHERE code = plan_code
$$;

-- Al registrar un tenant o al cambiarle el plan (RF-06), copia el plan VIGENTE en ese momento.
-- Las ediciones posteriores del plan no lo tocan.
CREATE FUNCTION tenants_plan_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.plan IS DISTINCT FROM OLD.plan OR NEW.plan_snapshot IS NULL THEN
    NEW.plan_snapshot := plan_snapshot(NEW.plan);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_plan_snapshot BEFORE INSERT OR UPDATE OF plan, plan_snapshot ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_plan_snapshot();

-- Tenants ya registrados: el plan con el que se crearon es el vigente hasta hoy.
UPDATE tenants SET plan_snapshot = plan_snapshot(plan) WHERE plan_snapshot IS NULL;
ALTER TABLE tenants ALTER COLUMN plan_snapshot SET NOT NULL;
