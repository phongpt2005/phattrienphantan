-- ============================================================
-- SCHEMA TRUNG TÂM (CENTRAL) v2: Registry + Metadata Index + Chia sẻ + Audit CDC
-- ============================================================
-- * Idempotent: chạy được trên DB mới lẫn DB đang chạy (apply-schema.sh).
-- * KHÔNG seed phòng ban: phòng ban tự đăng ký qua Registry (R3).
-- * Thêm so với v1: lifecycle/heartbeat cho registry, source_version chống event cũ
--   ghi đè, cdc_partition_progress, FTS tiếng Việt không dấu, DDL document_share và
--   access_request (trước đây chỉ tồn tại do tạo thủ công).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'vn_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION vn_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION vn_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

-- ---------------------------------------------------------------- DEPARTMENT (Registry)
CREATE TABLE IF NOT EXISTS department (
    department_id     SERIAL          PRIMARY KEY,
    dept_code         VARCHAR(20)     NOT NULL UNIQUE,
    dept_name         VARCHAR(100)    NOT NULL,
    node_endpoint     VARCHAR(255)    NOT NULL DEFAULT '',
    kafka_topic       VARCHAR(100)    NOT NULL DEFAULT '',
    status            VARCHAR(10)     NOT NULL DEFAULT 'ACTIVE',
    registered_at     TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_dept_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
ALTER TABLE department ADD COLUMN IF NOT EXISTS lifecycle         VARCHAR(15) NOT NULL DEFAULT 'PROVISIONING';
ALTER TABLE department ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE department ADD COLUMN IF NOT EXISTS api_version       VARCHAR(10) NOT NULL DEFAULT 'v1';
ALTER TABLE department ADD COLUMN IF NOT EXISTS schema_version    SMALLINT    NOT NULL DEFAULT 1;
ALTER TABLE department ADD COLUMN IF NOT EXISTS capabilities      JSONB       NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE department ALTER COLUMN node_endpoint SET DEFAULT '';
ALTER TABLE department ALTER COLUMN kafka_topic   SET DEFAULT '';
ALTER TABLE department DROP CONSTRAINT IF EXISTS chk_dept_lifecycle;
ALTER TABLE department ADD CONSTRAINT chk_dept_lifecycle
    CHECK (lifecycle IN ('PROVISIONING', 'ACTIVE', 'DEGRADED', 'DRAINING', 'RETIRED'));

-- ---------------------------------------------------------------- SEARCH_DOCUMENT (Metadata Index)
CREATE TABLE IF NOT EXISTS search_document (
    central_doc_id  BIGSERIAL       PRIMARY KEY,
    department_id   INT             NOT NULL REFERENCES department(department_id),
    source_doc_id   BIGINT          NOT NULL,
    title           VARCHAR(255)    NOT NULL,
    description     VARCHAR(1000),
    category_name   VARCHAR(100),
    tags            VARCHAR(500),
    file_name       VARCHAR(255),
    mime_type       VARCHAR(100),
    version_no      INT,
    owner_name      VARCHAR(100),
    access_level    VARCHAR(20)     NOT NULL DEFAULT 'DEPARTMENT',
    status          VARCHAR(20)     NOT NULL DEFAULT 'DRAFT',
    created_at      TIMESTAMP,
    synced_at       TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dept_source_doc UNIQUE (department_id, source_doc_id),
    CONSTRAINT chk_search_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'DELETED')),
    CONSTRAINT chk_search_access CHECK (access_level IN ('PUBLIC', 'DEPARTMENT', 'PRIVATE'))
);
ALTER TABLE search_document ADD COLUMN IF NOT EXISTS search_vector  tsvector;
-- source_version = document.row_version ở node: event cũ không ghi đè được dữ liệu mới
ALTER TABLE search_document ADD COLUMN IF NOT EXISTS source_version BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION fn_update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.description, '')), 'B') ||
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.tags, '')), 'C') ||
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.file_name, '')), 'D') ||
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.category_name, '')), 'C') ||
        setweight(to_tsvector('vn_unaccent', COALESCE(NEW.owner_name, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_search_vector_update ON search_document;
CREATE TRIGGER trg_search_vector_update
    BEFORE INSERT OR UPDATE ON search_document
    FOR EACH ROW EXECUTE FUNCTION fn_update_search_vector();

CREATE INDEX IF NOT EXISTS idx_search_vector  ON search_document USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_search_dept    ON search_document(department_id);
CREATE INDEX IF NOT EXISTS idx_search_status  ON search_document(status);
CREATE INDEX IF NOT EXISTS idx_search_access  ON search_document(access_level);
CREATE INDEX IF NOT EXISTS idx_search_created ON search_document(created_at);
CREATE INDEX IF NOT EXISTS idx_search_synced  ON search_document(synced_at);
CREATE INDEX IF NOT EXISTS idx_search_mime    ON search_document(mime_type);

-- ---------------------------------------------------------------- SYNC_EVENT_LOG
CREATE TABLE IF NOT EXISTS sync_event_log (
    event_id        BIGSERIAL       PRIMARY KEY,
    department_id   INT             REFERENCES department(department_id),
    source_doc_id   BIGINT,
    event_type      VARCHAR(10)     NOT NULL,
    kafka_partition INT,
    kafka_offset    BIGINT,
    payload         JSONB,
    process_status  VARCHAR(10)     NOT NULL DEFAULT 'PENDING',
    error_message   VARCHAR(500),
    received_at     TIMESTAMP       NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMP,
    CONSTRAINT chk_event_type CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
    CONSTRAINT chk_process_status CHECK (process_status IN ('PENDING', 'DONE', 'FAILED', 'SKIPPED', 'DLQ'))
);
-- v1 chỉ cho PENDING/DONE/FAILED: nới ra để ghi nhận event bỏ qua (cũ) và event vào DLQ
ALTER TABLE sync_event_log DROP CONSTRAINT IF EXISTS chk_process_status;
ALTER TABLE sync_event_log ADD CONSTRAINT chk_process_status
    CHECK (process_status IN ('PENDING', 'DONE', 'FAILED', 'SKIPPED', 'DLQ'));
CREATE INDEX IF NOT EXISTS idx_sync_dept     ON sync_event_log(department_id);
CREATE INDEX IF NOT EXISTS idx_sync_status   ON sync_event_log(process_status);
CREATE INDEX IF NOT EXISTS idx_sync_received ON sync_event_log(received_at);
CREATE INDEX IF NOT EXISTS idx_sync_kafka    ON sync_event_log(kafka_partition, kafka_offset);

-- ---------------------------------------------------------------- CDC_PARTITION_PROGRESS
-- Offset đã áp dụng thành công, ghi CÙNG transaction với dữ liệu -> khởi động lại không mất/không lặp
CREATE TABLE IF NOT EXISTS cdc_partition_progress (
    consumer_group  VARCHAR(100)    NOT NULL,
    topic           VARCHAR(249)    NOT NULL,
    partition_id    INT             NOT NULL,
    last_offset     BIGINT          NOT NULL,
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer_group, topic, partition_id)
);

-- ---------------------------------------------------------------- SEARCH_HISTORY
CREATE TABLE IF NOT EXISTS search_history (
    search_id        BIGSERIAL      PRIMARY KEY,
    user_id          BIGINT,
    keyword          VARCHAR(255)   NOT NULL,
    filters          JSONB,
    result_count     INT,
    response_time_ms INT,
    created_at       TIMESTAMP      NOT NULL DEFAULT NOW()
);
-- v1 có FK tới global_user (bảng không còn dùng): gỡ FK nếu đang tồn tại
ALTER TABLE search_history DROP CONSTRAINT IF EXISTS search_history_user_id_fkey;
CREATE INDEX IF NOT EXISTS idx_search_hist_user    ON search_history(user_id);
CREATE INDEX IF NOT EXISTS idx_search_hist_created ON search_history(created_at);

-- ---------------------------------------------------------------- BẢN SAO SỔ CHIA SẺ (nguồn sự thật nằm ở NODE)
-- Sổ chia sẻ nay nằm ở node của phòng sở hữu tài liệu (bảng document_share trong DB của node). Trung tâm chỉ giữ bản sao
-- nhận qua Outbox (trường `shares` của sự kiện document) để (1) lọc quyền khi dùng chỉ mục dự phòng lúc node sập,
-- (2) làm báo cáo cho Ban Giám đốc. Mỗi phần tử: {shareId, sharedWith, permission, expiresAt, revoked, createdAt}.
ALTER TABLE search_document ADD COLUMN IF NOT EXISTS shares JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------- DOCUMENT_SHARE (CŨ, chỉ để tham chiếu)
-- Sổ chia sẻ cũ của trung tâm. KHÔNG còn được ghi hay đọc bởi ứng dụng; giữ lại để đối chiếu sau khi chạy
-- infrastructure/scripts/migrate-shares-to-nodes.sh. Có thể xóa bảng này khi đã kiểm tra xong.
CREATE TABLE IF NOT EXISTS document_share (
    share_id          BIGSERIAL     PRIMARY KEY,
    central_doc_id    BIGINT        NOT NULL REFERENCES search_document(central_doc_id) ON DELETE CASCADE,
    shared_by_dept    VARCHAR(20)   NOT NULL,
    shared_with_dept  VARCHAR(20)   NOT NULL,
    shared_by_user_id BIGINT,
    permission        VARCHAR(20)   NOT NULL DEFAULT 'VIEW',
    reason            VARCHAR(255),
    expires_at        TIMESTAMPTZ,
    is_revoked        BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_share_permission CHECK (permission IN ('VIEW', 'DOWNLOAD'))
);
-- v1 giới hạn mã phòng ban 10 ký tự: nới ra bằng với department.dept_code
ALTER TABLE document_share ALTER COLUMN shared_by_dept   TYPE VARCHAR(20);
ALTER TABLE document_share ALTER COLUMN shared_with_dept TYPE VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_doc_share_dept    ON document_share(shared_with_dept, is_revoked);
CREATE INDEX IF NOT EXISTS idx_doc_share_doc     ON document_share(central_doc_id);
CREATE INDEX IF NOT EXISTS idx_doc_share_expires ON document_share(expires_at);

-- ---------------------------------------------------------------- ACCESS_REQUEST
CREATE TABLE IF NOT EXISTS access_request (
    request_id           BIGSERIAL     PRIMARY KEY,
    central_doc_id       BIGINT        NOT NULL REFERENCES search_document(central_doc_id),
    requester_dept       VARCHAR(50)   NOT NULL,
    requester_username   VARCHAR(100)  NOT NULL,
    target_dept          VARCHAR(50)   NOT NULL,
    requested_days       INT           NOT NULL DEFAULT 7,
    reason               TEXT          NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
    reviewed_by          VARCHAR(100),
    reviewed_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   DEFAULT NOW(),
    requested_permission VARCHAR(20)   DEFAULT 'VIEW',
    CONSTRAINT chk_request_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS idx_access_req_target ON access_request(target_dept, status);
CREATE INDEX IF NOT EXISTS idx_access_req_doc    ON access_request(central_doc_id);

-- ---------------------------------------------------------------- DEPARTMENT_STATUS_EVENT (lịch sử sập/phục hồi)
-- Mỗi lần một node đổi vòng đời (ACTIVE -> DEGRADED khi mất heartbeat, -> DRAINING khi tắt có trật tự,
-- -> ACTIVE khi phục hồi) Registry ghi một dòng. Trang giám sát của Ban Giám đốc dựng lịch sử hoạt động,
-- danh sách sự cố và tỉ lệ sẵn sàng từ bảng này. Chỉ-thêm: không cập nhật, không xóa.
CREATE TABLE IF NOT EXISTS department_status_event (
    event_id     BIGSERIAL    PRIMARY KEY,
    dept_code    VARCHAR(20)  NOT NULL,
    from_state   VARCHAR(20),
    to_state     VARCHAR(20)  NOT NULL,
    reason       VARCHAR(200),
    occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dept_status_event_dept ON department_status_event(dept_code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dept_status_event_time ON department_status_event(occurred_at DESC);

-- ---------------------------------------------------------------- MÚI GIỜ: cột thời điểm phải có múi giờ
-- Các cột dưới đây được ghi bằng NOW() trong phiên chạy Asia/Ho_Chi_Minh nhưng khai báo "timestamp without time zone".
-- Dịch vụ Node đọc kiểu đó như giờ UTC nên giao diện hiển thị lệch 7 giờ. Chuyển sang timestamptz,
-- hiểu giá trị cũ là giờ Việt Nam. Idempotent: chỉ chạy khi cột còn là kiểu cũ.
-- (search_document.created_at giữ nguyên: đó là giờ UTC sao chép từ sự kiện của node.)
DO $fix_naive_timestamps$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('search_document', 'synced_at'),
      ('sync_event_log',  'received_at'),
      ('sync_event_log',  'processed_at'),
      ('search_history',  'created_at'),
      ('department',      'registered_at')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = c.tbl AND column_name = c.col
                  AND data_type = 'timestamp without time zone') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE %L', c.tbl, c.col, c.col, 'Asia/Ho_Chi_Minh');
    END IF;
  END LOOP;
END
$fix_naive_timestamps$;
