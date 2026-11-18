#!/usr/bin/env bash
# ============================================================
# TÁI THIẾT LẬP CHỈ MỤC TRUNG TÂM TỪ CÁC NODE (feature 3).
#   bash infrastructure/scripts/rebuild-central-index.sh
#
# Nguyên lý: node phòng ban là nguồn sự thật duy nhất (SSOT); search_document ở trung tâm chỉ là bản chiếu.
# Quy trình: sao lưu 3 bảng -> tháo khóa ngoại tạm -> TRUNCATE search_document -> resync song song các node
#            ACTIVE -> chờ Projector -> khôi phục dòng của phòng đã RETIRED (không còn node để resync)
#            -> ánh xạ lại central_doc_id theo khóa tự nhiên (department_id, source_doc_id)
#            -> đối soát -> khôi phục khóa ngoại.
# Không xóa bảng backup: giữ lại để đối chiếu sau khi chạy.
# Nếu có lỗi giữa chừng, khóa ngoại có thể đang bị tháo: script in rõ hướng khôi phục.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

C()  { docker exec -i postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -v ON_ERROR_STOP=1 -q "$@"; }
Cq() { docker exec postgres-central-primary psql -U "$POSTGRES_CENTRAL_USER" -d "$POSTGRES_CENTRAL_DB" -tAc "$1"; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (nhận '$2', mong đợi '$3')"; fi; }
FK_DROPPED=0
on_exit() {
  if [ "$FK_DROPPED" = 1 ]; then
    echo "!! Script dừng khi khóa ngoại đang bị tháo. Kiểm tra số liệu rồi khôi phục bằng tay:"
    echo "   ALTER TABLE access_request ADD CONSTRAINT access_request_central_doc_id_fkey FOREIGN KEY (central_doc_id) REFERENCES search_document(central_doc_id);"
    echo "   ALTER TABLE document_share ADD CONSTRAINT document_share_central_doc_id_fkey FOREIGN KEY (central_doc_id) REFERENCES search_document(central_doc_id) ON DELETE CASCADE;"
  fi
}
trap on_exit EXIT

# Ánh xạ phòng -> container DB của node (đọc user/db từ biến môi trường của chính container)
node_db_container() {
  case "$1" in
    HR) echo postgres-hr-primary ;;
    ACC) echo postgres-acc-primary ;;
    SALES) echo dept-sales-db ;;
    *) echo "" ;;
  esac
}
node_doc_count() {
  docker exec "$1" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from document"'
}

echo "== 0. Điều kiện ban đầu và đếm nguồn =="
[ "$(Cq "select to_regclass('search_document_backup') is null")" = t ] || { echo "Bảng backup đã tồn tại. Đổi tên hoặc xóa trước khi chạy để không ghi đè bản sao lưu cũ."; exit 1; }
ACTIVE_IDS=$(Cq "select string_agg(department_id::text, ',' order by department_id) from department where lifecycle='ACTIVE'")
ACTIVE_CODES=$(Cq "select string_agg(dept_code, ' ' order by department_id) from department where lifecycle='ACTIVE'")
echo "  phòng ACTIVE: $ACTIVE_CODES (department_id: $ACTIVE_IDS)"
EXPECTED=0
declare -A NODE_DOCS
for code in $ACTIVE_CODES; do
  c=$(node_db_container "$code")
  n=$(node_doc_count "$c"); NODE_DOCS[$code]=$n
  EXPECTED=$((EXPECTED + n))
  echo "  node $code: $n tài liệu (nguồn sự thật)"
done
CEN_TOTAL_BEFORE=$(Cq "select count(*) from search_document")
AR_BEFORE=$(Cq "select count(*) from access_request")
DS_BEFORE=$(Cq "select count(*) from document_share")
echo "  trước: search_document=$CEN_TOTAL_BEFORE, access_request=$AR_BEFORE, document_share=$DS_BEFORE"

echo "== 1. Sao lưu toàn diện (3 bảng) =="
C <<'SQL'
CREATE TABLE search_document_backup AS SELECT * FROM search_document;
CREATE TABLE access_request_backup AS SELECT * FROM access_request;
CREATE TABLE document_share_backup AS SELECT * FROM document_share;
SQL
chk "sao lưu search_document" "$(Cq "select count(*) from search_document_backup")" "$CEN_TOTAL_BEFORE"
chk "sao lưu access_request" "$(Cq "select count(*) from access_request_backup")" "$AR_BEFORE"
chk "sao lưu document_share" "$(Cq "select count(*) from document_share_backup")" "$DS_BEFORE"
# Dừng TRƯỚC khi tháo khóa ngoại hay TRUNCATE nếu bản sao lưu chưa khớp
[ "$FAIL" = 0 ] || { echo "Sao lưu chưa khớp: dừng trước khi thay đổi gì khác."; exit 1; }

echo "== 2. Tháo khóa ngoại tạm thời =="
C <<'SQL'
ALTER TABLE access_request DROP CONSTRAINT access_request_central_doc_id_fkey;
ALTER TABLE document_share DROP CONSTRAINT document_share_central_doc_id_fkey;
SQL
FK_DROPPED=1
chk "không còn khóa ngoại trỏ vào search_document" "$(Cq "select count(*) from pg_constraint where confrelid='search_document'::regclass")" 0

echo "== 3. Giả lập thảm họa: TRUNCATE search_document =="
C -c "TRUNCATE TABLE search_document;"
chk "chỉ mục trung tâm về 0" "$(Cq "select count(*) from search_document")" 0

echo "== 4. Resync song song các node ACTIVE =="
T_START=$(date +%s)
TMPD=$(mktemp -d)
for code in $ACTIVE_CODES; do
  dept=dept-$(echo "$code" | tr 'A-Z' 'a-z')
  ( docker exec "$dept" node -e 'fetch("http://localhost:3000/internal/resync",{method:"POST",headers:{"x-service-token":process.env.INTERNAL_SERVICE_TOKEN}}).then(r=>r.text()).then(t=>{console.log(t);process.exit(t.includes("replayed")?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})' > "$TMPD/$code.out" 2>&1; echo $? > "$TMPD/$code.rc" ) &
done
wait
for code in $ACTIVE_CODES; do
  rc=$(cat "$TMPD/$code.rc" 2>/dev/null || echo 9)
  out=$(cat "$TMPD/$code.out" 2>/dev/null)
  chk "resync $code thành công" "$rc" 0
  echo "    $code -> $out"
  rep=$(echo "$out" | python -I -c "import sys,json; print(json.loads(sys.stdin.read().strip().splitlines()[-1]).get('replayed',-1))" 2>/dev/null || echo -1)
  chk "resync $code phát đúng số tài liệu của node" "$rep" "${NODE_DOCS[$code]}"
done
rm -rf "$TMPD"

echo "== 5. Chờ Projector tiêu thụ xong hàng đợi =="
for i in $(seq 1 150); do
  N=$(Cq "select count(*) from search_document where department_id in ($ACTIVE_IDS)")
  [ "$N" = "$EXPECTED" ] && break
  sleep 2
done
T_REBUILD=$(( $(date +%s) - T_START ))
chk "chỉ mục đủ số tài liệu của các node ACTIVE" "$N" "$EXPECTED"
echo "  T_rebuild (từ lúc resync đến khi đủ chỉ mục): ${T_REBUILD} giây"

echo "== 6. Khôi phục dòng của phòng không còn node (RETIRED) =="
RETIRED_ROWS=$(Cq "select count(*) from search_document_backup where department_id not in ($ACTIVE_IDS)")
C <<SQL
INSERT INTO search_document (department_id, source_doc_id, title, description, category_name, tags, file_name, mime_type, version_no, owner_name, access_level, status, created_at, synced_at, source_version, shares)
SELECT b.department_id, b.source_doc_id, b.title, b.description, b.category_name, b.tags, b.file_name, b.mime_type, b.version_no, b.owner_name, b.access_level, b.status, b.created_at, b.synced_at, b.source_version, b.shares
FROM search_document_backup b
WHERE b.department_id NOT IN ($ACTIVE_IDS);
SQL
chk "dòng phòng RETIRED được giữ lại từ bản sao lưu" "$(Cq "select count(*) from search_document where department_id not in ($ACTIVE_IDS)")" "$RETIRED_ROWS"

echo "== 7. Ánh xạ lại central_doc_id theo khóa tự nhiên (department_id, source_doc_id) =="
C <<'SQL'
UPDATE access_request a SET central_doc_id = n.central_doc_id
FROM search_document_backup b JOIN search_document n ON n.department_id = b.department_id AND n.source_doc_id = b.source_doc_id
WHERE a.central_doc_id = b.central_doc_id;
UPDATE document_share d SET central_doc_id = n.central_doc_id
FROM search_document_backup b JOIN search_document n ON n.department_id = b.department_id AND n.source_doc_id = b.source_doc_id
WHERE d.central_doc_id = b.central_doc_id;
SQL

echo "== 8. Đối soát toàn vẹn trước khi khôi phục khóa ngoại =="
ORPHAN_AR=$(Cq "select count(*) from access_request a where not exists (select 1 from search_document s where s.central_doc_id = a.central_doc_id)")
ORPHAN_DS=$(Cq "select count(*) from document_share d where not exists (select 1 from search_document s where s.central_doc_id = d.central_doc_id)")
chk "access_request không mồ côi" "$ORPHAN_AR" 0
chk "document_share không mồ côi" "$ORPHAN_DS" 0
chk "access_request đủ số dòng" "$(Cq "select count(*) from access_request")" "$AR_BEFORE"
chk "document_share đủ số dòng" "$(Cq "select count(*) from document_share")" "$DS_BEFORE"
# Nguồn sự thật là node chủ (ADR-011): so số lượt chia sẻ của từng phòng ACTIVE với bảng document_share của node
for code in $ACTIVE_CODES; do
  c=$(node_db_container "$code")
  node_n=$(docker exec "$c" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from document_share"')
  cen_n=$(Cq "select coalesce(sum(jsonb_array_length(s.shares)),0) from search_document s join department d using(department_id) where d.dept_code='$code'")
  chk "shares của $code khớp node chủ (nguồn sự thật)" "$cen_n" "$node_n"
done
chk "tags không rỗng khớp bản sao lưu" "$(Cq "select count(*) from search_document where tags is not null and tags <> ''")" "$(Cq "select count(*) from search_document_backup where tags is not null and tags <> ''")"

if [ "$ORPHAN_AR" = 0 ] && [ "$ORPHAN_DS" = 0 ]; then
  echo "== 9. Khôi phục khóa ngoại =="
  C <<'SQL'
ALTER TABLE access_request ADD CONSTRAINT access_request_central_doc_id_fkey FOREIGN KEY (central_doc_id) REFERENCES search_document(central_doc_id);
ALTER TABLE document_share ADD CONSTRAINT document_share_central_doc_id_fkey FOREIGN KEY (central_doc_id) REFERENCES search_document(central_doc_id) ON DELETE CASCADE;
SQL
  FK_DROPPED=0
  chk "khóa ngoại được khôi phục" "$(Cq "select count(*) from pg_constraint where confrelid='search_document'::regclass")" 2
else
  bad "có dòng mồ côi: KHÔNG khôi phục khóa ngoại, cần quyết định trước (xem bảng backup)"
fi

echo
echo "===== KẾT QUẢ REBUILD: $PASS đạt, $FAIL lỗi | T_rebuild=${T_REBUILD}s ====="
[ "$FAIL" -eq 0 ]
