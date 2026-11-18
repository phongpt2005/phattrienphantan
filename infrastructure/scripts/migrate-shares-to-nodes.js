/**
 * Chuyển SỔ CHIA SẺ CŨ (bảng central.document_share) về NODE CHỦ TÀI LIỆU (ADR-010).
 *
 * - IDEMPOTENT: node dùng legacy_share_id làm khóa duy nhất, chạy lại bao nhiêu lần cũng không nhân đôi.
 * - Giữ nguyên lịch sử: lượt đã thu hồi vẫn được chuyển (is_revoked = true), thời điểm tạo giữ nguyên.
 * - KHÔNG xóa bảng cũ ở trung tâm (chỉ đánh dấu legacy trong schema); xóa là quyết định riêng sau khi đối soát.
 * - Chạy TRONG container Search Gateway (đã có DATABASE_URL, INTERNAL_SERVICE_TOKEN, mạng tới các node):
 *
 *     docker exec -i distributed-dms-search-engine-service-1 node - < infrastructure/scripts/migrate-shares-to-nodes.js
 *
 * Sau khi chạy xong, gọi /internal/resync của từng node (xem README bước chuyển) để bản sao `shares`
 * ở chỉ mục trung tâm được cập nhật.
 */
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  const header = process.env.SERVICE_TOKEN_HEADER || 'x-service-token';
  if (!token) throw new Error('Thiếu INTERNAL_SERVICE_TOKEN');

  const { rows } = await pool.query(`
    SELECT s.share_id, s.shared_with_dept, s.permission, s.reason, s.expires_at, s.is_revoked, s.created_at,
           d.dept_code AS owner_dept, d.node_endpoint, d.lifecycle, sd.source_doc_id
      FROM document_share s
      JOIN search_document sd ON sd.central_doc_id = s.central_doc_id
      JOIN department d ON d.department_id = sd.department_id
     ORDER BY s.share_id`);

  const stat = { total: rows.length, ok: 0, failed: 0 };
  const failures = [];
  for (const r of rows) {
    try {
      if (!r.node_endpoint) throw new Error('node chưa có endpoint');
      const res = await fetch(`${r.node_endpoint}/internal/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [header]: token },
        body: JSON.stringify({
          docId: Number(r.source_doc_id),
          sharedWithDept: r.shared_with_dept,
          permission: r.permission,
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
          reason: r.reason || 'Chuyển từ sổ chia sẻ trung tâm',
          createdBy: 'migration',
          source: 'MIGRATED',
          legacyShareId: Number(r.share_id),
          createdAt: new Date(r.created_at).toISOString(),
          isRevoked: r.is_revoked === true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status} ${body.message || ''}`);
      stat.ok++; // node idempotent: lượt mới hay đã có đều trả về dòng sổ
    } catch (e) {
      stat.failed++;
      failures.push(`share ${r.share_id} (${r.owner_dept} -> ${r.shared_with_dept}): ${e.message}`);
    }
  }
  console.log(JSON.stringify(stat));
  if (failures.length) console.log('THẤT BẠI:\n' + failures.join('\n'));
  await pool.end();
  process.exit(stat.failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
