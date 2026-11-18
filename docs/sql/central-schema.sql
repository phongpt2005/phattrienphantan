-- =====================================================================
-- CENTRAL SCHEMA (v2): IAM + Department Registry + Metadata Index
--                       + Sharing/Approval + Audit
-- PostgreSQL >= 15
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'vn_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION vn_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION vn_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

-- ---------------------------------------------------------------- IAM
CREATE TABLE users (
  user_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_issuer   VARCHAR(255) NOT NULL,      -- https://keycloak/realms/dms
  identity_subject  VARCHAR(255) NOT NULL,      -- claim "sub"
  display_name      VARCHAR(150) NOT NULL,
  email             VARCHAR(255),
  status            VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (identity_issuer, identity_subject)
);

CREATE TABLE roles (
  role_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_code   VARCHAR(40) NOT NULL UNIQUE,       -- STAFF, MANAGER, EXECUTIVE, AUDITOR
  role_name   VARCHAR(100) NOT NULL,
  scope_type  VARCHAR(15) NOT NULL CHECK (scope_type IN ('DEPARTMENT','GLOBAL'))
);

CREATE TABLE permissions (
  permission_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_code  VARCHAR(40) NOT NULL UNIQUE,  -- DOCUMENT_VIEW, DOCUMENT_DOWNLOAD, DOCUMENT_SHARE, ...
  description      VARCHAR(255)
);

CREATE TABLE role_permissions (
  role_id        BIGINT NOT NULL REFERENCES roles(role_id),
  permission_id  BIGINT NOT NULL REFERENCES permissions(permission_id),
  PRIMARY KEY (role_id, permission_id)
);

-- ------------------------------------------------- DEPARTMENT REGISTRY (R3)
CREATE TABLE departments (
  department_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_code  VARCHAR(30)  NOT NULL UNIQUE CHECK (department_code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  department_name  VARCHAR(150) NOT NULL,
  lifecycle        VARCHAR(15)  NOT NULL DEFAULT 'PROVISIONING'
                   CHECK (lifecycle IN ('PROVISIONING','ACTIVE','DEGRADED','DRAINING','RETIRED')),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Tách "định tuyến" khỏi "danh mục": 1 phòng ban có thể có nhiều endpoint (multi-replica / multi-region).
CREATE TABLE department_endpoints (
  department_id    BIGINT NOT NULL REFERENCES departments(department_id),
  endpoint_kind    VARCHAR(20) NOT NULL CHECK (endpoint_kind IN ('SEARCH','API','FILE')),
  base_url         VARCHAR(255) NOT NULL,      -- http://dept-hr-svc.dms.svc:3000
  api_version      VARCHAR(10)  NOT NULL DEFAULT 'v1',
  kafka_topic      VARCHAR(249),               -- dms.dept.hr.document
  schema_version   SMALLINT     NOT NULL DEFAULT 1,
  registered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, endpoint_kind)
);

CREATE TABLE department_health (
  department_id      BIGINT PRIMARY KEY REFERENCES departments(department_id),
  last_heartbeat_at  TIMESTAMPTZ NOT NULL,
  p95_latency_ms     INT,
  circuit_state      VARCHAR(10) NOT NULL DEFAULT 'CLOSED'
                     CHECK (circuit_state IN ('CLOSED','OPEN','HALF_OPEN')),
  instance_count     INT NOT NULL DEFAULT 1
);

-- Đặt sau departments vì có FK.
CREATE TABLE user_department_roles (
  user_id        UUID   NOT NULL REFERENCES users(user_id),
  department_id  BIGINT NOT NULL REFERENCES departments(department_id),
  role_id        BIGINT NOT NULL REFERENCES roles(role_id),
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, department_id, role_id)
);

CREATE TABLE user_global_roles (
  user_id      UUID   NOT NULL REFERENCES users(user_id),
  role_id      BIGINT NOT NULL REFERENCES roles(role_id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- --------------------------------------------- METADATA INDEX (fallback / CQRS)
CREATE TABLE document_metadata (
  department_id      BIGINT NOT NULL REFERENCES departments(department_id),
  document_id        UUID   NOT NULL,
  title              VARCHAR(255) NOT NULL,
  description        TEXT,
  original_filename  VARCHAR(255),
  mime_type          VARCHAR(100),
  category_path      VARCHAR(500),
  tags               TEXT[] NOT NULL DEFAULT '{}',
  classification     VARCHAR(20) NOT NULL,
  status             VARCHAR(20) NOT NULL,
  owner_user_id      UUID,
  is_deleted         BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL,
  source_updated_at  TIMESTAMPTZ NOT NULL,
  source_version     BIGINT NOT NULL,            -- = document.row_version ở node
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector      tsvector GENERATED ALWAYS AS (
                       setweight(to_tsvector('vn_unaccent', coalesce(title,'')), 'A') ||
                       setweight(to_tsvector('vn_unaccent', coalesce(original_filename,'')), 'B') ||
                       setweight(to_tsvector('vn_unaccent', coalesce(description,'')), 'C')
                     ) STORED,
  PRIMARY KEY (department_id, document_id)
);
CREATE INDEX ix_meta_search ON document_metadata USING GIN (search_vector) WHERE NOT is_deleted;
CREATE INDEX ix_meta_tags   ON document_metadata USING GIN (tags);
CREATE INDEX ix_meta_class  ON document_metadata (classification, department_id) WHERE NOT is_deleted;

CREATE TABLE cdc_partition_progress (
  consumer_group  VARCHAR(100) NOT NULL,
  topic           VARCHAR(249) NOT NULL,
  partition_id    INT NOT NULL,
  last_offset     BIGINT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, topic, partition_id)
);

-- ------------------------------------------------ SHARING & APPROVAL
CREATE TABLE access_request (
  request_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_department_id     BIGINT NOT NULL REFERENCES departments(department_id),
  document_id             UUID   NOT NULL,
  requester_user_id       UUID   NOT NULL REFERENCES users(user_id),
  requester_department_id BIGINT NOT NULL REFERENCES departments(department_id),
  requested_permission    VARCHAR(10) NOT NULL CHECK (requested_permission IN ('VIEW','DOWNLOAD')),
  reason                  VARCHAR(500),
  status                  VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_by              UUID REFERENCES users(user_id),
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_department_id, document_id) REFERENCES document_metadata(department_id, document_id),
  CHECK (owner_department_id <> requester_department_id)
);
-- Một người chỉ có 1 yêu cầu đang chờ cho cùng tài liệu.
CREATE UNIQUE INDEX ux_request_pending ON access_request (document_id, requester_user_id)
  WHERE status = 'PENDING';

CREATE TABLE document_share (
  share_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_department_id     BIGINT NOT NULL REFERENCES departments(department_id),
  document_id             UUID   NOT NULL,
  target_department_id    BIGINT NOT NULL REFERENCES departments(department_id),
  permission              VARCHAR(10) NOT NULL CHECK (permission IN ('VIEW','DOWNLOAD')),
  source_request_id       UUID REFERENCES access_request(request_id),
  granted_by              UUID NOT NULL REFERENCES users(user_id),
  granted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,
  revoked_by              UUID REFERENCES users(user_id),
  FOREIGN KEY (owner_department_id, document_id) REFERENCES document_metadata(department_id, document_id),
  CHECK (owner_department_id <> target_department_id),
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE UNIQUE INDEX ux_share_active ON document_share (document_id, target_department_id)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_share_target ON document_share (target_department_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------ AUDIT (append-only, hash chain)
CREATE TABLE audit_events (
  event_id        UUID NOT NULL,
  actor_type      VARCHAR(15) NOT NULL CHECK (actor_type IN ('USER','SYSTEM')),
  actor_user_id   UUID,
  source_service  VARCHAR(100) NOT NULL,
  department_id   BIGINT,
  action          VARCHAR(60) NOT NULL,
  resource_type   VARCHAR(30),
  resource_id     VARCHAR(100),
  outcome         VARCHAR(15) NOT NULL CHECK (outcome IN ('SUCCESS','FAILED','DENIED')),
  occurred_at     TIMESTAMPTZ NOT NULL,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id      VARCHAR(100),
  trace_id        VARCHAR(32),
  details         JSONB,
  prev_hash       BYTEA,
  hash            BYTEA NOT NULL,     -- sha256(prev_hash || canonical(row))
  PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_events_2026_11 PARTITION OF audit_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_events_2026_12 PARTITION OF audit_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE INDEX ix_audit_actor ON audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_dept  ON audit_events (department_id, action, occurred_at DESC);

-- Chặn UPDATE/DELETE: audit chỉ được thêm.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
