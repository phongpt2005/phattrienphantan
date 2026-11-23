-- =====================================================================
-- DEPARTMENT NODE SCHEMA (v2) - áp dụng giống hệt cho mọi phòng ban
-- PostgreSQL >= 15. Mỗi phòng ban 1 database riêng (R1).
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- UUIDv7: duy nhất toàn cục + tăng dần theo thời gian (PG18 có sẵn uuidv7()).
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  b bytea := gen_random_bytes(16);
BEGIN
  b := overlay(b PLACING substring(int8send(ts_ms) FROM 3) FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- variant RFC 9562
  RETURN encode(b, 'hex')::uuid;
END $$;

-- Full-text search tiếng Việt: bỏ dấu để "hop dong" khớp "hợp đồng".
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'vn_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION vn_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION vn_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

CREATE TABLE category (
  category_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id    INT REFERENCES category(category_id),
  name         VARCHAR(100) NOT NULL,
  description  VARCHAR(255),
  UNIQUE (parent_id, name)
);

CREATE TABLE tag (
  tag_id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tag_name  VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE document (
  document_id     UUID PRIMARY KEY DEFAULT uuid_v7(),
  category_id     INT REFERENCES category(category_id),
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  classification  VARCHAR(20) NOT NULL DEFAULT 'DEPARTMENT'
                  CHECK (classification IN ('DEPARTMENT','COMPANY','CONFIDENTIAL')),
  status          VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','PENDING_REVIEW','APPROVED','ARCHIVED')),
  current_version INT NOT NULL DEFAULT 0,
  row_version     BIGINT NOT NULL DEFAULT 1,        -- optimistic lock + thứ tự CDC
  created_by      UUID NOT NULL,                     -- users.user_id (IAM trung tâm)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  search_vector   tsvector GENERATED ALWAYS AS (
                    setweight(to_tsvector('vn_unaccent', coalesce(title,'')), 'A') ||
                    setweight(to_tsvector('vn_unaccent', coalesce(description,'')), 'B')
                  ) STORED
);
CREATE INDEX ix_document_search  ON document USING GIN (search_vector) WHERE deleted_at IS NULL;
CREATE INDEX ix_document_category ON document (category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_document_updated  ON document (updated_at DESC);

CREATE TABLE file_object (
  file_id          UUID PRIMARY KEY DEFAULT uuid_v7(),
  file_name        VARCHAR(255) NOT NULL,
  storage_key      VARCHAR(512) NOT NULL UNIQUE,   -- key trong bucket MinIO của phòng ban
  mime_type        VARCHAR(100) NOT NULL,
  size_bytes       BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256  CHAR(64) NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Thay cho quan hệ 1-1 DOCUMENT.file_id: giữ lịch sử phiên bản.
CREATE TABLE document_version (
  document_id  UUID NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  version_no   INT  NOT NULL,
  file_id      UUID NOT NULL UNIQUE REFERENCES file_object(file_id),
  change_note  VARCHAR(500),
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version_no)
);

CREATE TABLE document_tag (
  document_id  UUID NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  tag_id       INT  NOT NULL REFERENCES tag(tag_id),
  PRIMARY KEY (document_id, tag_id)
);

-- Outbox chung cho sự kiện nghiệp vụ + audit (Debezium Outbox Event Router).
CREATE TABLE outbox (
  event_id        UUID PRIMARY KEY DEFAULT uuid_v7(),
  aggregate_type  VARCHAR(40)  NOT NULL,   -- 'document' | 'audit'  -> route topic
  aggregate_id    VARCHAR(100) NOT NULL,   -- message key (giữ thứ tự / partition)
  event_type      VARCHAR(60)  NOT NULL,   -- DocumentCreated, DocumentUpdated, DOCUMENT_DOWNLOAD_DENIED...
  schema_version  SMALLINT     NOT NULL DEFAULT 1,
  payload         JSONB        NOT NULL,
  trace_id        VARCHAR(32),             -- W3C traceparent để nối trace qua Kafka
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Debezium chỉ đọc WAL; bảng được dọn định kỳ (event đã nằm trong Kafka).
CREATE INDEX ix_outbox_occurred ON outbox (occurred_at);

-- Tự tăng row_version + updated_at ở mọi UPDATE.
CREATE OR REPLACE FUNCTION trg_document_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at  := now();
  RETURN NEW;
END $$;
CREATE TRIGGER document_bump BEFORE UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION trg_document_bump();

-- Publication chỉ cho outbox (không lộ bảng nghiệp vụ ra ngoài).
CREATE PUBLICATION dms_outbox_pub FOR TABLE outbox;
