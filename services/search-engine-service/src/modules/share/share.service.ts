import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/** Thời hạn giữ chỗ PROCESSING: quá hạn (tiến trình chết giữa chừng) thì người khác được nhận lại yêu cầu. */
const CLAIM_LEASE = "interval '2 minutes'";
import { Pool } from 'pg';
import { AuthenticatedUser, SERVICE_TOKEN_HEADER, isExecutive, requireEnv } from '@dms/common';
import { NotificationService } from '../notification/notification.service';
import { RedisCacheService } from '../cache/redis-cache.service';
import { RegistryService } from '../registry/registry.service';

const SHARES_NODE_TIMEOUT_MS = 2500;

export type SharedItem = Record<string, any> & { created_at: string; shared_by_dept: string };

/** Kết quả phân tán: luôn trả phần lấy được, kèm danh sách node không trả lời để giao diện báo rõ. */
export interface SharesWithDeptResponse {
  shares: SharedItem[];
  /** true nếu có ít nhất một node không phản hồi (sập, quá 2,5 giây, hoặc đang suy giảm) */
  isPartial: boolean;
  /** Mã các phòng ban không trả lời, vd ['SALES', 'LEGAL'] */
  unavailableNodes: string[];
}

/**
 * Quy trình XIN QUYỀN liên phòng ban (nằm ở trung tâm vì cần nhìn được cả hai phía: phòng xin và phòng duyệt).
 *
 * Sổ chia sẻ KHÔNG còn ở đây: lượt chia sẻ nằm ở node của phòng sở hữu tài liệu (department-service, bảng
 * document_share). Tại đây chỉ còn:
 *  - tạo, liệt kê, từ chối yêu cầu xin quyền;
 *  - DUYỆT yêu cầu = gọi node chủ tạo lượt chia sẻ (idempotent theo mã yêu cầu), rồi mới đóng yêu cầu;
 *  - tổng hợp "Được chia sẻ với tôi" bằng cách hỏi các node.
 */
@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly pool: Pool,
    private readonly cacheService: RedisCacheService,
    private readonly notifications: NotificationService,
    private readonly registry: RegistryService,
  ) {}

  // ------------------------------------------------------------------ được chia sẻ với tôi
  /**
   * Hỏi từng node: "tài liệu nào của bạn đang được chia sẻ cho phòng tôi?". Node sập thì bỏ qua phần của node đó
   * (dữ liệu nằm ở node nên không có nguồn nào khác chính xác hơn).
   */
  async getSharesWithDept(deptCode: string): Promise<SharesWithDeptResponse> {
    const depts = (await this.registry.listForSearch()).filter((d) => d.dept_code !== deptCode);
    // Node đang DEGRADED/DRAINING hoặc không có địa chỉ thì chắc chắn không hỏi được: báo ngay, không chờ hết giờ
    const skipped = depts.filter((d) => ['DEGRADED', 'DRAINING'].includes(d.lifecycle) || (d.lifecycle === 'ACTIVE' && !d.node_endpoint)).map((d) => d.dept_code);
    const parts = await Promise.all(
      depts
        .filter((d) => d.lifecycle === 'ACTIVE' && d.node_endpoint)
        .map(async (d): Promise<{ rows: SharedItem[]; failed?: string }> => {
          try {
            const res = await fetch(`${d.node_endpoint}/internal/shares/with?dept=${encodeURIComponent(deptCode)}`, {
              headers: { [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
              signal: AbortSignal.timeout(SHARES_NODE_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rows = (await res.json()) as any[];
            return { rows: rows.map((r) => ({ ...r, shared_by_dept: d.dept_code, shared_by_dept_name: d.dept_name })) };
          } catch (err: any) {
            this.logger.warn(`Không lấy được danh sách chia sẻ từ node ${d.dept_code}: ${err.message}`);
            return { rows: [], failed: d.dept_code };
          }
        }),
    );
    const unavailableNodes = [...skipped, ...parts.flatMap((p) => (p.failed ? [p.failed] : []))].sort();
    return {
      shares: parts.flatMap((p) => p.rows).sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
      // Thiếu node thì nói thẳng: người dùng không phải đoán tài liệu "mất" là do bị thu hồi hay do node bảo trì
      isPartial: unavailableNodes.length > 0,
      unavailableNodes,
    };
  }

  // ------------------------------------------------------------------ yêu cầu xin quyền
  async createAccessRequest(
    input: {
      centralDocId?: number;
      sourceDocId?: number;
      targetDept?: string;
      requestedDays?: number;
      requestedPermission?: 'VIEW' | 'DOWNLOAD';
      reason: string;
    },
    actor: AuthenticatedUser,
  ) {
    // Người xin và phòng ban của họ lấy từ TOKEN (không tin dữ liệu client gửi)
    const data = { ...input, requesterDept: actor.departmentCode, requesterUsername: actor.username };
    let resolvedCentralDocId = data.centralDocId;
    let targetDept = data.targetDept;

    if (!resolvedCentralDocId && data.sourceDocId && targetDept) {
      const lookup = await this.pool.query(
        `SELECT d.central_doc_id, dept.dept_code
         FROM search_document d
         JOIN department dept ON d.department_id = dept.department_id
         WHERE d.source_doc_id = $1 AND dept.dept_code = $2 AND d.status != 'DELETED'
         ORDER BY d.central_doc_id DESC LIMIT 1`,
        [data.sourceDocId, targetDept],
      );
      if (lookup.rows.length === 0) {
        throw new NotFoundException(`Không tìm thấy tài liệu gốc ID ${data.sourceDocId} của phòng "${targetDept}"`);
      }
      resolvedCentralDocId = Number(lookup.rows[0].central_doc_id);
    }

    if (!resolvedCentralDocId) {
      throw new BadRequestException('Cần cung cấp centralDocId hoặc sourceDocId');
    }

    // Lấy thông tin phòng sở hữu tài liệu nếu chưa có
    if (!targetDept) {
      const docCheck = await this.pool.query(
        `SELECT dept.dept_code
         FROM search_document d
         JOIN department dept ON d.department_id = dept.department_id
         WHERE d.central_doc_id = $1`,
        [resolvedCentralDocId],
      );
      if (docCheck.rows.length === 0) {
        throw new NotFoundException(`Không tìm thấy tài liệu ID ${resolvedCentralDocId}`);
      }
      targetDept = docCheck.rows[0].dept_code;
    }

    if (data.requesterDept === targetDept) {
      throw new BadRequestException('Không thể gửi yêu cầu xin xem tài liệu của chính phòng ban mình');
    }

    const days = Number(data.requestedDays) || 7;
    const reqPerm = data.requestedPermission === 'DOWNLOAD' ? 'DOWNLOAD' : 'VIEW';
    const res = await this.pool.query(
      `INSERT INTO access_request (
        central_doc_id, requester_dept, requester_username, target_dept, requested_days, requested_permission, reason, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', NOW(), NOW())
      RETURNING *;`,
      [resolvedCentralDocId, data.requesterDept, data.requesterUsername || 'Staff', targetDept, days, reqPerm, data.reason || 'Yêu cầu phối hợp nghiệp vụ'],
    );

    this.notifications.publish({
      type: 'ACCESS_REQUESTED',
      title: 'Có yêu cầu xin quyền cần duyệt',
      message: `${data.requesterUsername} (phòng ${data.requesterDept}) xin ${reqPerm === 'DOWNLOAD' ? 'xem và tải' : 'xem'} một tài liệu của phòng bạn.`,
      targetDept: targetDept,
      roles: ['MANAGER'],
    });
    this.logger.log(`Yêu cầu mới: [${data.requesterUsername} (${data.requesterDept})] xin tài liệu [${resolvedCentralDocId} (${targetDept})] ${days} ngày, quyền [${reqPerm}]`);
    return {
      message: 'Gửi yêu cầu xin cấp quyền xem tài liệu thành công',
      request: res.rows[0],
    };
  }

  /** Chỉ Trưởng phòng của phòng ban SỞ HỮU tài liệu (hoặc Ban Giám đốc) mới được duyệt. */
  private assertCanReview(req: { target_dept: string }, actor: AuthenticatedUser) {
    if (isExecutive(actor)) return;
    if (actor.role !== 'MANAGER' || actor.departmentCode !== req.target_dept) {
      throw new ForbiddenException('Chỉ Trưởng phòng của phòng ban sở hữu tài liệu (hoặc Ban Giám đốc) mới được duyệt yêu cầu này');
    }
  }

  async getAccessRequests(deptCode?: string, isExecutive = false) {
    let sql = `
      SELECT r.*, d.title, d.description, d.file_name, d.category_name, d.mime_type, d.source_doc_id
      FROM access_request r
      JOIN search_document d ON r.central_doc_id = d.central_doc_id
    `;
    const params: any[] = [];

    if (!isExecutive && deptCode) {
      sql += ` WHERE (r.target_dept = $1 OR r.requester_dept = $1) `;
      params.push(deptCode);
    }

    sql += ` ORDER BY r.created_at DESC;`;

    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  /**
   * Duyệt yêu cầu (chọn quyền VIEW hoặc DOWNLOAD).
   *
   * THỨ TỰ có chủ đích: (1) gọi node chủ tạo lượt chia sẻ, (2) rồi mới đóng yêu cầu. Node tạo idempotent theo mã yêu cầu,
   * nên nếu bước 2 lỗi thì duyệt lại không tạo lượt thứ hai; nếu node đang sập thì yêu cầu vẫn ở trạng thái CHỜ DUYỆT
   * (không có chuyện yêu cầu "đã duyệt" mà quyền chưa hề được cấp).
   */
  async approveAccessRequest(requestId: number, actor: AuthenticatedUser, grantedPermission?: 'VIEW' | 'DOWNLOAD') {
    const reviewerUsername = actor.username;
    const check = await this.pool.query(`SELECT * FROM access_request WHERE request_id = $1`, [requestId]);
    if (check.rows.length === 0) throw new NotFoundException(`Không tìm thấy yêu cầu cấp quyền ID ${requestId}`);

    const req = check.rows[0];
    this.assertCanReview(req, actor);
    if (req.status === 'PROCESSING') {
      throw new ConflictException('Yêu cầu đang được người khác xử lý, vui lòng tải lại sau ít phút');
    }
    if (req.status !== 'PENDING') {
      throw new BadRequestException(`Yêu cầu này đã được xử lý trước đó (Trạng thái: ${req.status})`);
    }

    // Giữ chỗ nguyên tử (compare-and-set): chỉ MỘT người duyệt đi tiếp. Người thứ hai nhận 409.
    // Nhận lại được yêu cầu PROCESSING đã quá hạn (tiến trình trước chết sau khi giữ chỗ); node cấp quyền idempotent
    // theo accessRequestId nên duyệt lại không tạo lượt chia sẻ thứ hai.
    const claim = await this.pool.query(
      `UPDATE access_request SET status = 'PROCESSING', reviewed_by = $1, updated_at = NOW()
        WHERE request_id = $2
          AND (status = 'PENDING' OR (status = 'PROCESSING' AND updated_at < NOW() - ${CLAIM_LEASE}))`,
      [reviewerUsername, requestId],
    );
    if (claim.rowCount !== 1) {
      throw new ConflictException('Yêu cầu đang được người khác xử lý hoặc đã được xử lý');
    }
    try {
      return await this.completeApproval(requestId, req, reviewerUsername, grantedPermission);
    } catch (err) {
      // Không cấp được: trả yêu cầu về CHỜ DUYỆT để thử lại sau
      await this.pool
        .query(`UPDATE access_request SET status = 'PENDING', reviewed_by = NULL, updated_at = NOW() WHERE request_id = $1 AND status = 'PROCESSING'`, [requestId])
        .catch((e) => this.logger.error(`Không trả được yêu cầu [${requestId}] về PENDING: ${e.message}`));
      throw err;
    }
  }

  private async completeApproval(requestId: number, req: any, reviewerUsername: string, grantedPermission?: 'VIEW' | 'DOWNLOAD') {
    const finalPermission: 'VIEW' | 'DOWNLOAD' = grantedPermission || (req.requested_permission === 'DOWNLOAD' ? 'DOWNLOAD' : 'VIEW');
    const expiresAt = new Date(Date.now() + (Number(req.requested_days) || 7) * 24 * 60 * 60 * 1000);

    // Tìm node chủ và mã tài liệu tại node đó
    const docRes = await this.pool.query(
      `SELECT d.source_doc_id, dept.dept_code
         FROM search_document d JOIN department dept ON dept.department_id = d.department_id
        WHERE d.central_doc_id = $1`,
      [req.central_doc_id],
    );
    if (docRes.rows.length === 0) throw new NotFoundException('Không tìm thấy tài liệu của yêu cầu này trong chỉ mục');
    const owner = (await this.registry.listForSearch()).find((d) => d.dept_code === docRes.rows[0].dept_code);
    if (!owner || owner.lifecycle !== 'ACTIVE' || !owner.node_endpoint) {
      throw new ServiceUnavailableException(`Node phòng ${docRes.rows[0].dept_code} đang không phục vụ nên chưa thể cấp quyền. Yêu cầu vẫn chờ duyệt, vui lòng thử lại khi node hoạt động.`);
    }

    let share: unknown;
    let nodeAction: string | undefined;
    try {
      const res = await fetch(`${owner.node_endpoint}/internal/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
        body: JSON.stringify({
          docId: Number(docRes.rows[0].source_doc_id),
          sharedWithDept: req.requester_dept,
          permission: finalPermission,
          expiresAt: expiresAt.toISOString(),
          reason: `Đã duyệt quyền [${finalPermission}]: ${req.reason} (Người duyệt: ${reviewerUsername})`,
          createdBy: reviewerUsername,
          source: 'REQUEST',
          accessRequestId: requestId,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new BadRequestException(body?.message || `Node ${owner.dept_code} từ chối cấp quyền (HTTP ${res.status})`);
      share = body.share;
      nodeAction = body.action;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new ServiceUnavailableException(`Không gọi được node ${owner.dept_code} để cấp quyền: ${err.message}. Yêu cầu vẫn chờ duyệt.`);
    }

    const done = await this.pool.query(
      `UPDATE access_request
          SET status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
        WHERE request_id = $2 AND status = 'PROCESSING' AND reviewed_by = $1`,
      [reviewerUsername, requestId],
    );
    if (done.rowCount !== 1) {
      // Giữ chỗ đã quá hạn và người khác đã nhận lại. Quyền ở node vẫn đúng (idempotent); không gửi thông báo trùng.
      throw new ConflictException('Yêu cầu đã được người khác hoàn tất trong lúc đang xử lý');
    }

    await this.cacheService.invalidateSearchCache();
    if (nodeAction === 'SUPERSEDED') {
      // Node đã có quyền MỚI HƠN từ một yêu cầu khác: quyền hiện hành không đổi. Không báo "đã cấp quyền".
      this.logger.warn(`Yêu cầu [${requestId}] được duyệt nhưng quyền hiện hành tại ${req.target_dept} mới hơn: không đổi quyền`);
      return {
        message: 'Đã ghi nhận duyệt. Phòng chủ đã có quyền mới hơn từ một yêu cầu khác nên quyền hiện hành KHÔNG thay đổi.',
        share,
        superseded: true,
      };
    }
    this.notifications.publish({
      type: 'ACCESS_APPROVED',
      title: 'Yêu cầu xin quyền đã được duyệt',
      message: `Phòng ${req.target_dept} đã cấp quyền ${finalPermission === 'DOWNLOAD' ? 'xem và tải về' : 'chỉ xem'} cho yêu cầu của bạn.`,
      targetDept: req.requester_dept,
      username: req.requester_username,
    });
    this.logger.log(`Yêu cầu [${requestId}] ĐÃ DUYỆT quyền [${finalPermission}] bởi [${reviewerUsername}], hiệu lực đến ${expiresAt.toISOString()}`);

    return {
      message: `Phê duyệt yêu cầu thành công. Đã cấp quyền [${finalPermission === 'DOWNLOAD' ? 'XEM & TẢI VỀ' : 'CHỈ XEM TRỰC TUYẾN'}]`,
      share,
    };
  }

  async rejectAccessRequest(requestId: number, actor: AuthenticatedUser, rejectReason = '') {
    const reviewerUsername = actor.username;
    const check = await this.pool.query(`SELECT * FROM access_request WHERE request_id = $1`, [requestId]);
    if (check.rows.length === 0) throw new NotFoundException(`Không tìm thấy yêu cầu cấp quyền ID ${requestId}`);

    const req = check.rows[0];
    this.assertCanReview(req, actor);
    if (req.status === 'PROCESSING') {
      throw new ConflictException('Yêu cầu đang được người khác xử lý, vui lòng tải lại sau ít phút');
    }
    if (req.status !== 'PENDING') {
      throw new BadRequestException(`Yêu cầu này đã được xử lý trước đó (Trạng thái: ${req.status})`);
    }

    const rejected = await this.pool.query(
      `UPDATE access_request
       SET status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW(),
           reason = CASE WHEN $2 != '' THEN reason || ' [Lý do từ chối: ' || $2 || ']' ELSE reason END
       WHERE request_id = $3 AND status = 'PENDING'`,
      [reviewerUsername, rejectReason, requestId],
    );
    if (rejected.rowCount !== 1) {
      throw new ConflictException('Yêu cầu đang được người khác xử lý hoặc đã được xử lý');
    }

    this.notifications.publish({
      type: 'ACCESS_REJECTED',
      title: 'Yêu cầu xin quyền bị từ chối',
      message: `Phòng ${req.target_dept} từ chối yêu cầu của bạn${rejectReason ? `: ${rejectReason}` : '.'}`,
      targetDept: req.requester_dept,
      username: req.requester_username,
    });
    this.logger.log(`Yêu cầu [${requestId}] BỊ TỪ CHỐI bởi [${reviewerUsername}]`);
    return { message: 'Đã từ chối yêu cầu cấp quyền xem' };
  }
}
