-- ============================================================
-- SCHEMA CHUNG CHO MỌI NODE PHÒNG BAN (v2)
-- ============================================================
-- * Một file duy nhất cho HR, ACC, SALES... (thêm phòng ban không cần schema mới).
-- * Idempotent: chạy được trên DB mới (docker-entrypoint-initdb.d) lẫn DB đang
--   chạy (xem infrastructure/scripts/apply-schema.sh).
-- * Thêm so với v1: row_version, bảng outbox (Transactional Outbox),
--   cấu hình full-text search tiếng Việt không dấu, publication chỉ gồm outbox.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Cấu hình tìm kiếm tiếng Việt: "hop dong" khớp "Hợp đồng"
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'vn_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION vn_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION vn_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

-- ---------------------------------------------------------------- CATEGORY
CREATE TABLE IF NOT EXISTS category (
    category_id     SERIAL          PRIMARY KEY,
    parent_id       INT             REFERENCES category(category_id) ON DELETE SET NULL,
    name            VARCHAR(100)    NOT NULL,
    description     VARCHAR(255),
    CONSTRAINT chk_no_self_parent CHECK (category_id <> parent_id)
);
CREATE INDEX IF NOT EXISTS idx_category_parent ON category(parent_id);

-- ---------------------------------------------------------------- TAG
CREATE TABLE IF NOT EXISTS tag (
    tag_id      SERIAL          PRIMARY KEY,
    tag_name    VARCHAR(50)     NOT NULL UNIQUE
);

-- ---------------------------------------------------------------- LOCAL_USER
CREATE TABLE IF NOT EXISTS local_user (
    user_id         BIGSERIAL       PRIMARY KEY,
    username        VARCHAR(50)     NOT NULL UNIQUE,
    full_name       VARCHAR(100)    NOT NULL,
    email           VARCHAR(100),
    password_hash   VARCHAR(255),
    role            VARCHAR(20)     NOT NULL DEFAULT 'STAFF',
    status          VARCHAR(10)     NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT chk_user_role   CHECK (role IN ('ADMIN', 'MANAGER', 'STAFF')),
    CONSTRAINT chk_user_status CHECK (status IN ('ACTIVE', 'LOCKED'))
);
ALTER TABLE local_user ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_local_user_username ON local_user(username);
CREATE INDEX IF NOT EXISTS idx_local_user_status   ON local_user(status);

-- ---------------------------------------------------------------- DOCUMENT
CREATE TABLE IF NOT EXISTS document (
    doc_id              BIGSERIAL       PRIMARY KEY,
    title               VARCHAR(255)    NOT NULL,
    description         VARCHAR(1000),
    category_id         INT             REFERENCES category(category_id) ON DELETE SET NULL,
    created_by          BIGINT          NOT NULL REFERENCES local_user(user_id),
    current_version     INT             NOT NULL DEFAULT 1,
    status              VARCHAR(20)     NOT NULL DEFAULT 'DRAFT',
    access_level        VARCHAR(20)     NOT NULL DEFAULT 'DEPARTMENT',
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP,
    CONSTRAINT chk_doc_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'DELETED')),
    CONSTRAINT chk_doc_access CHECK (access_level IN ('PUBLIC', 'DEPARTMENT', 'PRIVATE'))
);
-- row_version: tăng ở mỗi UPDATE -> Central dùng để chặn event cũ ghi đè dữ liệu mới
ALTER TABLE document ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_document_status     ON document(status);
CREATE INDEX IF NOT EXISTS idx_document_category   ON document(category_id);
CREATE INDEX IF NOT EXISTS idx_document_created_by ON document(created_by);
CREATE INDEX IF NOT EXISTS idx_document_created_at ON document(created_at);
CREATE INDEX IF NOT EXISTS idx_document_updated_at ON document(updated_at);
-- Full-text search chạy ngay tại node (phục vụ federated query /internal/search)
CREATE INDEX IF NOT EXISTS idx_document_fts ON document
    USING GIN (to_tsvector('vn_unaccent', coalesce(title, '') || ' ' || coalesce(description, '')));

-- Nội dung văn bản trích từ tệp (do content-worker ghi qua /internal/documents/:id/content).
-- Nội dung KHÔNG rời node: Central Index chỉ nhận cờ content_indexed_version (giữ đúng nguyên tắc phân đoạn dữ liệu).
ALTER TABLE document ADD COLUMN IF NOT EXISTS content_text            TEXT;
ALTER TABLE document ADD COLUMN IF NOT EXISTS content_tsv             tsvector;
ALTER TABLE document ADD COLUMN IF NOT EXISTS content_indexed_version INT;
ALTER TABLE document ADD COLUMN IF NOT EXISTS content_extractor       VARCHAR(30);
CREATE INDEX IF NOT EXISTS idx_document_content_fts ON document USING GIN (content_tsv);

-- ---------------------------------------------------------------- FILE_OBJECT
CREATE TABLE IF NOT EXISTS file_object (
    file_id         BIGSERIAL       PRIMARY KEY,
    file_name       VARCHAR(255)    NOT NULL,
    storage_path    VARCHAR(500)    NOT NULL UNIQUE,
    mime_type       VARCHAR(100)    NOT NULL,
    size_bytes      BIGINT          NOT NULL,
    checksum_sha256 CHAR(64)        NOT NULL,
    uploaded_at     TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_file_size CHECK (size_bytes > 0)
);
CREATE INDEX IF NOT EXISTS idx_file_object_mime ON file_object(mime_type);

-- ---------------------------------------------------------------- DOCUMENT_VERSION
CREATE TABLE IF NOT EXISTS document_version (
    version_id      BIGSERIAL       PRIMARY KEY,
    doc_id          BIGINT          NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
    version_no      INT             NOT NULL,
    file_id         BIGINT          NOT NULL REFERENCES file_object(file_id),
    change_note     VARCHAR(500),
    created_by      BIGINT          REFERENCES local_user(user_id),
    created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_doc_version UNIQUE (doc_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_docversion_doc ON document_version(doc_id);

-- ---------------------------------------------------------------- DOCUMENT_TAG
CREATE TABLE IF NOT EXISTS document_tag (
    doc_id      BIGINT  NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
    tag_id      INT     NOT NULL REFERENCES tag(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, tag_id)
);

-- ---------------------------------------------------------------- ACCESS_PERMISSION
CREATE TABLE IF NOT EXISTS access_permission (
    permission_id       BIGSERIAL       PRIMARY KEY,
    doc_id              BIGINT          NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
    user_id             BIGINT          NOT NULL REFERENCES local_user(user_id),
    permission_level    VARCHAR(10)     NOT NULL,
    granted_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_perm_level CHECK (permission_level IN ('VIEW', 'DOWNLOAD', 'EDIT', 'OWNER')),
    CONSTRAINT uq_doc_user_perm UNIQUE (doc_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_access_perm_doc  ON access_permission(doc_id);
CREATE INDEX IF NOT EXISTS idx_access_perm_user ON access_permission(user_id);

-- ---------------------------------------------------------------- AUDIT_LOG
CREATE TABLE IF NOT EXISTS audit_log (
    log_id          BIGSERIAL       PRIMARY KEY,
    user_id         BIGINT          REFERENCES local_user(user_id),
    doc_id          BIGINT          REFERENCES document(doc_id) ON DELETE SET NULL,
    action          VARCHAR(20)     NOT NULL,
    detail          VARCHAR(500),
    ip_address      VARCHAR(45),
    created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_audit_action CHECK (action IN ('CREATE', 'VIEW', 'DOWNLOAD', 'UPDATE', 'DELETE'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_doc     ON audit_log(doc_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ---------------------------------------------------------------- AUDIT: chuỗi băm chống sửa đổi
-- Mỗi dòng audit mang entry_hash = SHA-256(prev_hash | nội dung dòng); prev_hash là entry_hash của dòng liền trước.
-- Trigger BEFORE INSERT tự tính ngay trong CSDL (ứng dụng không thể "quên" hoặc làm giả), và bảng chỉ-ghi
-- (UPDATE/DELETE bị chặn). Sửa hoặc xóa một dòng cũ sẽ làm đứt chuỗi và bị GET /audit/verify phát hiện.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash  CHAR(64);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash CHAR(64);
-- chain_seq KHÔNG nằm trong nội dung được băm: nó chỉ ghi thứ tự nối chuỗi nên cấp bổ sung không làm mất giá trị chống sửa nội dung.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq  BIGINT;

CREATE OR REPLACE FUNCTION audit_row_hash(prev CHAR, id BIGINT, uid BIGINT, did BIGINT, act VARCHAR, det VARCHAR, ip VARCHAR, ts TIMESTAMP)
RETURNS CHAR(64) LANGUAGE sql IMMUTABLE AS $f$
  SELECT encode(sha256(convert_to(
    prev || '|' || id || '|' || COALESCE(uid::text, '') || '|' || COALESCE(did::text, '') || '|' || act || '|' ||
    COALESCE(det, '') || '|' || COALESCE(ip, '') || '|' || to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex')
$f$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE prev CHAR(64); prevseq BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);  -- tuần tự hóa để chuỗi không bị rẽ nhánh khi ghi đồng thời
  -- Thứ tự chuỗi = chain_seq, cấp NGAY TRONG khóa. Không dùng log_id: log_id lấy từ sequence TRƯỚC khi giành khóa nên
  -- hai lần ghi đồng thời có thể giành khóa ngược thứ tự log_id (đã gặp: kiểm tra báo "đứt chuỗi" dù không ai sửa).
  SELECT entry_hash, chain_seq INTO prev, prevseq FROM audit_log WHERE entry_hash IS NOT NULL
   ORDER BY chain_seq DESC NULLS LAST, log_id DESC LIMIT 1;
  NEW.chain_seq  := COALESCE(prevseq, 0) + 1;
  NEW.prev_hash  := COALESCE(prev, repeat('0', 64));
  NEW.entry_hash := audit_row_hash(NEW.prev_hash, NEW.log_id, NEW.user_id, NEW.doc_id, NEW.action, NEW.detail, NEW.ip_address, NEW.created_at);
  RETURN NEW;
END $f$;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'audit_log là bảng chỉ-ghi: không được % dòng nhật ký', TG_OP;
END $f$;

-- Bổ sung chain_seq cho dòng đã có (một lần): đi theo liên kết prev_hash -> entry_hash từ dòng đầu tiên.
-- Cần tạm tắt trigger bất biến; chỉ ghi cột chain_seq, không đụng nội dung hay giá trị băm.
DO $backfill_chain_seq$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_log WHERE entry_hash IS NOT NULL AND chain_seq IS NULL) AND
     EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND tgname = 'trg_audit_immutable') THEN
    ALTER TABLE audit_log DISABLE TRIGGER trg_audit_immutable;
    WITH RECURSIVE chain AS (
      SELECT log_id, entry_hash, 1::bigint AS seq FROM audit_log WHERE prev_hash = repeat('0', 64) AND entry_hash IS NOT NULL
      UNION ALL
      SELECT a.log_id, a.entry_hash, c.seq + 1 FROM audit_log a JOIN chain c ON a.prev_hash = c.entry_hash
    )
    UPDATE audit_log a SET chain_seq = c.seq FROM chain c WHERE a.log_id = c.log_id AND a.chain_seq IS NULL;
    ALTER TABLE audit_log ENABLE TRIGGER trg_audit_immutable;
  END IF;
END
$backfill_chain_seq$;

DROP TRIGGER IF EXISTS trg_audit_chain ON audit_log;
CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- ---------------------------------------------------------------- OUTBOX (Transactional Outbox)
-- Service ghi outbox TRONG CÙNG transaction với thay đổi nghiệp vụ.
-- Debezium (Outbox Event Router) đọc WAL của bảng này và đẩy lên Kafka:
--   topic = dms.dept.<code>.<aggregate_type>,  key = aggregate_id
CREATE TABLE IF NOT EXISTS outbox (
    event_id        UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  VARCHAR(40)     NOT NULL,
    aggregate_id    VARCHAR(100)    NOT NULL,
    event_type      VARCHAR(60)     NOT NULL,
    schema_version  SMALLINT        NOT NULL DEFAULT 1,
    payload         JSONB           NOT NULL,
    trace_id        VARCHAR(55),
    occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_occurred ON outbox(occurred_at);

-- ---------------------------------------------------------------- TRIGGER
-- Mỗi UPDATE: cập nhật updated_at và tăng row_version
CREATE OR REPLACE FUNCTION fn_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at  := NOW();
    NEW.row_version := OLD.row_version + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_document_updated ON document;
CREATE TRIGGER trg_document_updated
    BEFORE UPDATE ON document
    FOR EACH ROW
    EXECUTE FUNCTION fn_update_timestamp();

-- ---------------------------------------------------------------- DOCUMENT_SHARE (sổ chia sẻ của PHÒNG NÀY)
-- Mọi lượt chia sẻ tài liệu của phòng cho phòng khác nằm ở đây, trong DB của node. Node tự kiểm tra bảng này khi
-- tìm kiếm (/internal/search) và khi tải file (/internal/files/:id/stream). Thu hồi có hiệu lực ngay tại node,
-- không phụ thuộc CSDL trung tâm. Trung tâm chỉ nhận BẢN SAO qua Outbox (trường `shares` của sự kiện document).
CREATE TABLE IF NOT EXISTS document_share (
    share_id          BIGSERIAL     PRIMARY KEY,
    doc_id            BIGINT        NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
    shared_with_dept  VARCHAR(20)   NOT NULL,                 -- mã phòng ban nhận; '*' = toàn công ty
    permission        VARCHAR(20)   NOT NULL DEFAULT 'VIEW',  -- VIEW: chỉ xem (DLP) | DOWNLOAD: xem và tải về
    reason            VARCHAR(255),
    expires_at        TIMESTAMPTZ,                            -- NULL = không thời hạn; hết hạn tính lúc truy vấn (expires_at > NOW())
    is_revoked        BOOLEAN       NOT NULL DEFAULT FALSE,
    revoked_at        TIMESTAMPTZ,
    revoked_by        VARCHAR(100),
    created_by        VARCHAR(100),
    source            VARCHAR(20)   NOT NULL DEFAULT 'DIRECT', -- DIRECT: Trưởng phòng chia sẻ | REQUEST: duyệt yêu cầu xin quyền | MIGRATED: chuyển từ sổ cũ ở trung tâm
    access_request_id BIGINT,                                 -- yêu cầu (ở trung tâm) đã sinh ra lượt này: để duyệt lại không tạo trùng
    legacy_share_id   BIGINT,                                 -- share_id cũ ở trung tâm: để chuyển dữ liệu chạy lại không tạo trùng
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_node_share_permission CHECK (permission IN ('VIEW', 'DOWNLOAD')),
    CONSTRAINT chk_node_share_source     CHECK (source IN ('DIRECT', 'REQUEST', 'MIGRATED'))
);
CREATE INDEX IF NOT EXISTS idx_node_share_doc  ON document_share(doc_id, is_revoked);
CREATE INDEX IF NOT EXISTS idx_node_share_with ON document_share(shared_with_dept, is_revoked, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_node_share_request ON document_share(access_request_id) WHERE access_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_node_share_legacy  ON document_share(legacy_share_id)   WHERE legacy_share_id IS NOT NULL;
-- Chống đua: mỗi cặp (tài liệu, phòng nhận) chỉ có TỐI ĐA MỘT lượt chưa thu hồi, do CSDL bảo đảm ở mức vật lý
-- (nhấp đúp, hai Trưởng phòng thao tác cùng lúc). Lượt đã thu hồi được giữ làm lịch sử nên không bị ràng buộc.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_share ON document_share(doc_id, shared_with_dept) WHERE NOT is_revoked;

-- ---------------------------------------------------------------- PUBLICATION
-- Chỉ phát hành bảng outbox: bảng nghiệp vụ không lộ ra ngoài,
-- đổi schema nội bộ không làm vỡ consumer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'dms_outbox_pub') THEN
    CREATE PUBLICATION dms_outbox_pub FOR TABLE outbox;
  END IF;
END $$;

-- ---------------------------------------------------------------- SEED
-- Danh mục mặc định (chỉ khi bảng còn trống). Người dùng demo do service tự seed khi
-- SEED_DEMO_USERS=true (xem department-service/SeedService).
INSERT INTO category (name, description)
SELECT v.name, v.description
FROM (VALUES
    ('Hợp đồng',  'Các loại hợp đồng'),
    ('Quyết định', 'Quyết định nội bộ'),
    ('Báo cáo',   'Báo cáo nội bộ'),
    ('Biểu mẫu',  'Các biểu mẫu, form')
) AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM category);

INSERT INTO local_user (username, full_name, email, role, status)
SELECT 'admin', 'Administrator', 'admin@company.local', 'ADMIN', 'ACTIVE'
WHERE NOT EXISTS (SELECT 1 FROM local_user WHERE username = 'admin');

-- Feature 4b: thu hồi token (Expand: thêm cột có DEFAULT, không đổi cột cũ)
ALTER TABLE local_user ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- P0.5.3: sổ lịch sử chia sẻ tại NODE (nguồn sự thật). Chỉ thêm (append-only), ghi cùng transaction với lượt chia sẻ.
CREATE TABLE IF NOT EXISTS document_share_history (
    history_id        BIGSERIAL     PRIMARY KEY,
    share_id          BIGINT        NOT NULL,
    doc_id            BIGINT        NOT NULL,
    shared_with_dept  VARCHAR(20)   NOT NULL,
    permission        VARCHAR(20)   NOT NULL,
    expires_at        TIMESTAMPTZ,
    action            VARCHAR(12)   NOT NULL,
    access_request_id BIGINT,
    actor             VARCHAR(100),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_share_history_action CHECK (action IN ('GRANTED', 'RENEWED', 'REVOKED', 'SUPERSEDED'))
);
CREATE INDEX IF NOT EXISTS idx_share_hist_share ON document_share_history(share_id);
CREATE INDEX IF NOT EXISTS idx_share_hist_req   ON document_share_history(access_request_id) WHERE access_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_share_history_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'document_share_history là bảng chỉ-thêm (append-only): không được sửa hoặc xóa';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_share_history_immutable ON document_share_history;
CREATE TRIGGER trg_share_history_immutable
    BEFORE UPDATE OR DELETE ON document_share_history
    FOR EACH ROW EXECUTE FUNCTION fn_share_history_immutable();

-- Backfill (idempotent): mọi lượt đã có trước đây được ghi là GRANTED; lượt đã thu hồi thêm REVOKED
INSERT INTO document_share_history (share_id, doc_id, shared_with_dept, permission, expires_at, action, access_request_id, actor, created_at)
SELECT s.share_id, s.doc_id, s.shared_with_dept, s.permission, s.expires_at, 'GRANTED', s.access_request_id, s.created_by, s.created_at
  FROM document_share s
 WHERE NOT EXISTS (SELECT 1 FROM document_share_history h WHERE h.share_id = s.share_id AND h.action = 'GRANTED');
INSERT INTO document_share_history (share_id, doc_id, shared_with_dept, permission, expires_at, action, access_request_id, actor, created_at)
SELECT s.share_id, s.doc_id, s.shared_with_dept, s.permission, s.expires_at, 'REVOKED', s.access_request_id, s.revoked_by, COALESCE(s.revoked_at, s.updated_at)
  FROM document_share s
 WHERE s.is_revoked AND NOT EXISTS (SELECT 1 FROM document_share_history h WHERE h.share_id = s.share_id AND h.action = 'REVOKED');
