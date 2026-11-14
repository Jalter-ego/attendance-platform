ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check
  CHECK (type IN ('diagnostic', 'backup', 'restore', 'create', 'suspend', 'resume',
                  'upgrade', 'plan-change', 'delete', 'preview-plan', 'preview-delete'));

ALTER TABLE operation_events ADD COLUMN stage varchar(100);

CREATE TABLE deployment_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode varchar(20) NOT NULL CHECK (mode IN ('local','integration'))
);

CREATE TABLE local_inventory (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  inventory jsonb NOT NULL
);

CREATE TABLE local_backups (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE platform_alerts (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  severity varchar(40) NOT NULL,
  message varchar(1000) NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_scans (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scanner varchar(60) NOT NULL,
  status varchar(40) NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
