#!/usr/bin/env bash
# ============================================================
# P1 B2: chép CSDL trung tâm từ máy chủ đơn cũ sang cụm Patroni.
#   bash infrastructure/scripts/central-migrate.sh rehearse   (thử: không dừng gì; so cấu trúc và số dòng)
#   bash infrastructure/scripts/central-migrate.sh cutover    (thật: dừng search để không ai ghi, chép, đối chiếu TỪNG BẢNG)
#
# Chế độ cutover:
#   1. Dừng search-engine-service (thành phần duy nhất ghi CSDL trung tâm). Tìm kiếm tạm dừng trong lúc chép.
#   2. pg_dump máy cũ -> psql vào máy chính của cụm (ON_ERROR_STOP).
#   3. So từng bảng: số dòng và md5 của toàn bộ nội dung; so sequence, chỉ mục, ràng buộc, trigger, extension.
#   4. CÓ SAI KHÁC: bật lại search (vẫn trỏ máy cũ), thoát 1, KHÔNG chuyển.
#      KHỚP HẾT: giữ search dừng, thoát 0. Người vận hành đổi DATABASE_URL rồi tạo lại search.
# Máy cũ không bị sửa (chỉ đọc). Không in mật khẩu.
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
export MSYS_NO_PATHCONV=1
MODE="${1:-}"
case "$MODE" in rehearse|cutover) ;; *) echo "Cách dùng: $0 rehearse|cutover"; exit 2;; esac
OLD=postgres-central-primary
U="$POSTGRES_CENTRAL_USER"; D="$POSTGRES_CENTRAL_DB"
leader() { local c; for c in central-pg-1 central-pg-2; do docker exec "$c" wget -q -T 3 -O /dev/null http://127.0.0.1:8008/primary 2>/dev/null && { echo "$c"; return; }; done; }
NEW=$(leader)
[ -n "$NEW" ] || { echo "Cụm Patroni chưa có máy chính. Dừng."; exit 2; }
echo "Nguồn: $OLD ; đích: $NEW ; chế độ: $MODE"
old() { docker exec "$OLD" psql -U "$U" -d "$D" -tAc "$1"; }
new() { docker exec "$NEW" psql -U "$U" -d "$D" -tAc "$1"; }
search_ids() { docker ps -q --filter name=search-engine-service; }
STOPPED=""
restart_search() { [ -n "$STOPPED" ] && docker start $STOPPED >/dev/null && echo "đã bật lại search (vẫn trỏ máy cũ)"; STOPPED=""; }
fail() { echo "KHÔNG ĐẠT: $1"; restart_search; exit 1; }

if [ "$MODE" = cutover ]; then
  STOPPED=$(docker ps -aq --filter name=search-engine-service --filter status=running | tr '\n' ' ')
  echo "[$(date +%H:%M:%S)] dừng search (tìm kiếm tạm dừng từ lúc này)"; docker stop $STOPPED >/dev/null
  for _ in $(seq 1 20); do n=$(old "select count(*) from pg_stat_activity where datname='$D' and pid<>pg_backend_pid() and backend_type='client backend' and application_name !~ 'walreceiver'"); [ "$n" = 0 ] && break; sleep 1; done
  [ "$n" = 0 ] || fail "còn $n kết nối khác tới CSDL trung tâm"
fi

docker exec "$NEW" psql -U "$U" -d postgres -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS $D WITH (FORCE)" -c "CREATE DATABASE $D OWNER $U TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'" || fail "tạo CSDL đích lỗi"
t0=$(date +%s)
docker exec "$OLD" pg_dump -U "$U" -d "$D" | docker exec -i "$NEW" psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 -q -o /dev/null
rc=("${PIPESTATUS[@]}")
[ "${rc[0]}" = 0 ] && [ "${rc[1]}" = 0 ] || fail "chép dữ liệu lỗi (pg_dump=${rc[0]}, psql=${rc[1]})"
echo "[$(date +%H:%M:%S)] chép xong sau $(( $(date +%s)-t0 )) giây"
docker exec "$NEW" psql -U "$U" -d "$D" -qc 'ANALYZE' || fail "ANALYZE lỗi"

BAD=0
cmp_val() { # nhãn, giá trị cũ, giá trị mới
  if [ -n "$2" ] && [ "$2" = "$3" ]; then echo "  khớp  $1"; else echo "  KHÁC  $1 (cũ '$2', mới '$3')"; BAD=$((BAD+1)); fi; }
cmp_val "số bảng" "$(old "select count(*) from pg_tables where schemaname='public'")" "$(new "select count(*) from pg_tables where schemaname='public'")"
cmp_val "chỉ mục" "$(old "select md5(string_agg(indexdef,'|' order by indexname)) from pg_indexes where schemaname='public'")" "$(new "select md5(string_agg(indexdef,'|' order by indexname)) from pg_indexes where schemaname='public'")"
# pg_dump viết lại CHECK ... ANY (ARRAY[...]) theo cách khác (ép kiểu khác chỗ): chuẩn hóa bỏ ép kiểu và ngoặc, giữ nguyên từng giá trị cho phép
QCON="select md5(string_agg(conrelid::regclass::text||'|'||conname::text||'|'||contype::text||'|'||convalidated::text||'|'||regexp_replace(pg_get_constraintdef(oid), '(::character varying|::text\[\]|::text|[() ])', '', 'g'), '~' order by conrelid::regclass::text, conname)) from pg_constraint where connamespace='public'::regnamespace"
cmp_val "ràng buộc (chuẩn hóa)" "$(old "$QCON")" "$(new "$QCON")"
cmp_val "trigger" "$(old "select count(*)||':'||coalesce(md5(string_agg(pg_get_triggerdef(oid),'|' order by tgname)),'') from pg_trigger where not tgisinternal")" "$(new "select count(*)||':'||coalesce(md5(string_agg(pg_get_triggerdef(oid),'|' order by tgname)),'') from pg_trigger where not tgisinternal")"
cmp_val "extension" "$(old "select string_agg(extname||extversion,',' order by extname) from pg_extension")" "$(new "select string_agg(extname||extversion,',' order by extname) from pg_extension")"
[ "$MODE" = cutover ] && cmp_val "sequence" "$(old "select md5(coalesce(string_agg(sequencename||'='||coalesce(last_value::text,'-'),',' order by sequencename),'khong')) from pg_sequences")" "$(new "select md5(coalesce(string_agg(sequencename||'='||coalesce(last_value::text,'-'),',' order by sequencename),'khong')) from pg_sequences")"
for t in $(old "select tablename from pg_tables where schemaname='public' order by 1"); do
  if [ "$MODE" = cutover ]; then
    q="select count(*)||':'||coalesce(md5(string_agg(x::text,'|' order by x::text)),'rong') from $t x"
  else
    q="select count(*) from $t"
  fi
  cmp_val "bảng $t" "$(old "$q" | tr -d '\r')" "$(new "$q" | tr -d '\r')"
done

if [ "$BAD" -gt 0 ]; then
  if [ "$MODE" = rehearse ]; then echo "THỬ: $BAD chỗ khác (bảng đang được ghi có thể lệch vài dòng, chấp nhận ở chế độ thử)"; exit 0; fi
  fail "$BAD chỗ khác nhau"
fi
echo "ĐẠT: mọi bảng và cấu trúc khớp"
[ "$MODE" = cutover ] && echo "search đang DỪNG (container: $STOPPED). Đổi DATABASE_URL rồi tạo lại search."
exit 0
