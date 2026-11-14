CREATE TABLE plans (
  code varchar(40) PRIMARY KEY,
  name varchar(100) NOT NULL,
  sizing jsonb NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO plans(code, name, sizing, limits) VALUES
  ('basic', 'Básico', '{"frontend":"t3.micro","backend":"t3.micro","db":"t3.micro","db_disk_gb":10}', '{"max_students":100,"max_teachers":10,"max_courses":20}'),
  ('standard', 'Estándar', '{"frontend":"t3.micro","backend":"t3.small","db":"t3.small","db_disk_gb":50}', '{"max_students":1000,"max_teachers":50,"max_courses":100}'),
  ('advanced', 'Avanzado', '{"frontend":"t3.small","backend":"t3.medium","db":"t3.medium","db_disk_gb":200}', '{"max_students":5000,"max_teachers":200,"max_courses":500}');

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  tenant_id varchar(40) NOT NULL,
  env varchar(4) NOT NULL CHECK (env IN ('test', 'prod')),
  name varchar(150) NOT NULL,
  contact_email varchar(255) NOT NULL,
  timezone varchar(100) NOT NULL DEFAULT 'America/La_Paz',
  region varchar(30) NOT NULL DEFAULT 'us-east-2',
  plan varchar(40) NOT NULL REFERENCES plans(code),
  engine varchar(20) NOT NULL CHECK (engine IN ('terraform', 'tofu', 'pulumi', 'cloudformation')),
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'provisioning', 'ready', 'suspending', 'suspended', 'resuming', 'deleting', 'deleted', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, env)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name varchar(150) NOT NULL,
  email varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('platform_admin', 'tenant_admin')),
  tenant_id uuid REFERENCES tenants(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'platform_admin' AND tenant_id IS NULL) OR (role = 'tenant_admin' AND tenant_id IS NOT NULL))
);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type varchar(30) NOT NULL CHECK (type IN ('diagnostic')),
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage varchar(100) NOT NULL DEFAULT 'En cola',
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  initiated_by uuid NOT NULL REFERENCES users(id),
  retry_of uuid REFERENCES operations(id),
  cancel_requested boolean NOT NULL DEFAULT false,
  worker_id uuid,
  heartbeat_at timestamptz,
  error_message varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- También protege frente a dos peticiones o procesos API simultáneos.
CREATE UNIQUE INDEX operations_one_active_per_tenant ON operations(tenant_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX operations_queue ON operations(created_at) WHERE status = 'queued';

CREATE TABLE operation_events (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations(id),
  level varchar(10) NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message text NOT NULL CHECK (length(message) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operation_events_cursor ON operation_events(operation_id, id);

CREATE TABLE deployments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  operation_id uuid UNIQUE REFERENCES operations(id),
  engine varchar(20) NOT NULL,
  ami jsonb NOT NULL DEFAULT '{}',
  outputs jsonb NOT NULL DEFAULT '{}',
  resources jsonb NOT NULL DEFAULT '[]',
  tool_versions jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployments_tenant ON deployments(tenant_id, created_at DESC);
