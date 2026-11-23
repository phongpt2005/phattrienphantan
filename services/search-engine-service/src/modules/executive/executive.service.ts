import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class ExecutiveService {
  private readonly logger = new Logger(ExecutiveService.name);

  constructor(private readonly pool: Pool) {}

  /**
   * Bảng điều khiển tổng quan dành cho Ban Giám Đốc (Executive Dashboard)
   */
  async getDashboard() {
    // 1. Tổng số tài liệu đang hoạt động toàn doanh nghiệp
    const totalDocsResult = await this.pool.query(
      `SELECT COUNT(*) AS total_documents FROM search_document WHERE status != 'DELETED';`,
    );

    // 2. Thống kê tài liệu và dung lượng/lần đồng bộ theo từng phòng ban
    const deptStatsResult = await this.pool.query(`
      SELECT 
        dept.department_id,
        dept.dept_code,
        dept.dept_name,
        dept.lifecycle,
        COUNT(d.central_doc_id) AS active_documents,
        MAX(d.synced_at) AS last_synced_at
      FROM department dept
      LEFT JOIN search_document d ON dept.department_id = d.department_id AND d.status != 'DELETED'
      WHERE dept.lifecycle <> 'RETIRED'
      GROUP BY dept.department_id, dept.dept_code, dept.dept_name, dept.lifecycle
      ORDER BY dept.department_id ASC;
    `);

    // 3. Thống kê theo trạng thái văn bản (DRAFT, PUBLISHED, ARCHIVED, DELETED)
    const statusStatsResult = await this.pool.query(`
      SELECT status, COUNT(*) AS count 
      FROM search_document 
      GROUP BY status 
      ORDER BY count DESC;
    `);

    // 4. Thống kê chia sẻ liên phòng ban (Cross-department Sharing)
    const shareStatsResult = await this.pool.query(`
      SELECT 
        COUNT(*) AS total_shares_created,
        COUNT(*) FILTER (WHERE NOT revoked AND (exp IS NULL OR exp > NOW())) AS active_shares,
        COUNT(*) FILTER (WHERE revoked OR (exp IS NOT NULL AND exp <= NOW())) AS expired_or_revoked_shares
      FROM (
        SELECT COALESCE((sh->>'revoked')::boolean, FALSE) AS revoked, (sh->>'expiresAt')::timestamptz AS exp
          FROM search_document d CROSS JOIN LATERAL jsonb_array_elements(d.shares) sh
         WHERE d.status <> 'DELETED'
      ) x;
    `);

    // 5. Tình trạng sức khỏe đường ống đồng bộ CDC (Debezium + Kafka Sync Health)
    const syncHealthResult = await this.pool.query(`
      SELECT 
        COUNT(*) AS total_cdc_events,
        COUNT(*) FILTER (WHERE process_status = 'DONE') AS successful_events,
        COUNT(*) FILTER (WHERE process_status IN ('FAILED', 'DLQ')) AS failed_events,
        COUNT(*) FILTER (WHERE process_status = 'SKIPPED') AS skipped_events,
        MAX(received_at) AS last_event_time
      FROM sync_event_log;
    `);

    return {
      overview: {
        totalActiveDocuments: parseInt(totalDocsResult.rows[0]?.total_documents || '0', 10),
        systemHealth: 'OPERATIONAL',
        generatedAt: new Date().toISOString(),
      },
      departments: deptStatsResult.rows,
      documentStatusBreakdown: statusStatsResult.rows,
      crossDepartmentSharing: shareStatsResult.rows[0] || {
        total_shares_created: 0,
        active_shares: 0,
        expired_or_revoked_shares: 0,
      },
      cdcPipelineHealth: syncHealthResult.rows[0] || {
        total_cdc_events: 0,
        successful_events: 0,
        failed_events: 0,
        last_event_time: null,
      },
    };
  }

  /**
   * Dòng sự kiện kiểm toán thời gian thực toàn doanh nghiệp (Centralized Audit Stream)
   */
  async getAuditStream(limit = 20) {
    const sql = `
      SELECT 
        l.event_id,
        dept.dept_code,
        dept.dept_name,
        l.source_doc_id,
        l.event_type,
        l.received_at,
        l.process_status,
        COALESCE(l.payload->>'title', 'Tài liệu #' || l.source_doc_id) AS document_title,
        COALESCE(l.payload->>'status', 'UNKNOWN') AS document_status,
        COALESCE(l.payload->>'ownerName', l.payload->>'owner_name', 'System') AS actor
      FROM sync_event_log l
      LEFT JOIN department dept ON l.department_id = dept.department_id
      ORDER BY l.received_at DESC
      LIMIT $1;
    `;
    const res = await this.pool.query(sql, [limit]);
    return {
      total: res.rows.length,
      events: res.rows,
    };
  }

  /**
   * Báo cáo phân tích chuyên sâu cho lãnh đạo (Analytics)
   */
  async getAnalytics() {
    const fileTypes = await this.pool.query(`
      SELECT mime_type, COUNT(*) AS count
      FROM search_document
      WHERE status != 'DELETED' AND mime_type IS NOT NULL
      GROUP BY mime_type
      ORDER BY count DESC;
    `);

    const topShared = await this.pool.query(`
      SELECT
        d.central_doc_id,
        d.title,
        dept.dept_code                       AS shared_by_dept,
        sh->>'sharedWith'                    AS shared_with_dept,
        sh->>'permission'                    AS permission,
        (sh->>'createdAt')::timestamptz      AS created_at,
        (sh->>'expiresAt')::timestamptz      AS expires_at
      FROM search_document d
      JOIN department dept ON dept.department_id = d.department_id
      CROSS JOIN LATERAL jsonb_array_elements(d.shares) sh
      WHERE d.status <> 'DELETED'
        AND NOT COALESCE((sh->>'revoked')::boolean, FALSE)
        AND (sh->>'expiresAt' IS NULL OR (sh->>'expiresAt')::timestamptz > NOW())
      ORDER BY created_at DESC
      LIMIT 10;
    `);

    return {
      fileTypeDistribution: fileTypes.rows,
      activeSharedDocuments: topShared.rows,
    };
  }
}
