CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid REFERENCES tenants(id),
  operation_id uuid REFERENCES operations(id),
  action varchar(40) NOT NULL,
  details varchar(500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_created_at ON audit_log(created_at DESC, id);

ALTER TABLE tenants ADD COLUMN plan_config jsonb;
UPDATE tenants t SET plan_config = jsonb_build_object('code', p.code, 'sizing', p.sizing, 'limits', p.limits)
  FROM plans p WHERE p.code = t.plan;
ALTER TABLE tenants ALTER COLUMN plan_config SET NOT NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_config_matches_plan
  CHECK (plan_config ->> 'code' IS NOT NULL AND plan_config ->> 'code' = plan);

-- Capture the plan for in-flight changes and recent confirmations made before this migration.
UPDATE operations o SET params = o.params || jsonb_build_object(
  'plan_config', jsonb_build_object('code', p.code, 'sizing', p.sizing, 'limits', p.limits)
)
  FROM plans p
 WHERE o.type IN ('preview-plan', 'plan-change') AND p.code = o.params ->> 'plan'
   AND NOT o.params ? 'plan_config';
