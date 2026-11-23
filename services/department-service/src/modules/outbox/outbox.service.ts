import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@dms/database';
import { requireEnv } from '@dms/common';

type Tx = Prisma.TransactionClient;

export type DocumentEventType =
  | 'DocumentCreated'
  | 'DocumentUpdated'
  | 'DocumentDeleted'
  | 'DocumentResynced';

/**
 * Hợp đồng sự kiện `document` (schema_version = 1).
 * Đây là API công khai của node: Search/Projector chỉ phụ thuộc vào cấu trúc này,
 * KHÔNG phụ thuộc vào cấu trúc bảng nội bộ của node.
 */
export interface DocumentEventPayload {
  documentId: number;
  departmentCode: string;
  title: string;
  description: string | null;
  categoryName: string | null;
  tags: string[];
  fileName: string | null;
  mimeType: string | null;
  versionNo: number;
  ownerName: string | null;
  accessLevel: string;
  status: string;
  createdAt: string;
  rowVersion: number;
  deleted: boolean;
  /** Phiên bản tệp đã được trích nội dung (null = chưa). Trường bổ sung, tương thích ngược với v1. */
  contentIndexedVersion: number | null;
  /** Bản sao sổ chia sẻ của tài liệu (chủ yếu cho chỉ mục dự phòng và báo cáo ở trung tâm). Nguồn sự thật là node. */
  shares: Array<{ shareId: number; sharedWith: string; permission: string; expiresAt: string | null; revoked: boolean; createdAt: string }>;
}

@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Ghi sự kiện vào outbox TRONG transaction `tx` của thao tác nghiệp vụ:
   * hoặc cả hai cùng thành công, hoặc cùng rollback (không còn dual-write).
   */
  async emitDocumentChanged(tx: Tx, docId: bigint | number, eventType: DocumentEventType): Promise<void> {
    const doc = await tx.document.findUnique({
      where: { docId: BigInt(docId) },
      include: {
        category: true,
        creator: { select: { fullName: true } },
        documentTags: { include: { tag: true } },
        versions: { orderBy: { versionNo: 'desc' }, take: 1, include: { file: true } },
      },
    });
    if (!doc) return;

    const latest = doc.versions[0];
    const extra = await tx.$queryRaw<Array<{ content_indexed_version: number | null }>>`
      SELECT content_indexed_version FROM document WHERE doc_id = ${BigInt(docId)}`;
    const shareRows = await tx.$queryRaw<Array<{ share_id: bigint; shared_with_dept: string; permission: string; expires_at: Date | null; is_revoked: boolean; created_at: Date }>>`
      SELECT share_id, shared_with_dept, permission, expires_at, is_revoked, created_at
        FROM document_share WHERE doc_id = ${BigInt(docId)} ORDER BY share_id DESC LIMIT 50`;
    const deleted = doc.status === 'DELETED';
    const payload: DocumentEventPayload = {
      documentId: Number(doc.docId),
      departmentCode: requireEnv('DEPT_CODE'),
      title: doc.title,
      description: doc.description ?? null,
      categoryName: doc.category?.name ?? null,
      tags: doc.documentTags.map((dt) => dt.tag.tagName),
      fileName: latest?.file?.fileName ?? null,
      mimeType: latest?.file?.mimeType ?? null,
      versionNo: doc.currentVersion,
      ownerName: doc.creator?.fullName ?? null,
      accessLevel: doc.accessLevel,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
      rowVersion: Number(doc.rowVersion),
      deleted,
      contentIndexedVersion: extra[0]?.content_indexed_version ?? null,
      shares: shareRows.map((r) => ({
        shareId: Number(r.share_id),
        sharedWith: r.shared_with_dept,
        permission: r.permission,
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        revoked: r.is_revoked,
        createdAt: r.created_at.toISOString(),
      })),
    };

    await tx.outbox.create({
      data: {
        aggregateType: 'document',
        aggregateId: String(doc.docId),
        eventType: deleted ? 'DocumentDeleted' : eventType,
        schemaVersion: 1,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Phát lại toàn bộ tài liệu hiện có vào outbox (backfill/đồng bộ lại Central Index).
   * An toàn khi chạy nhiều lần: Projector bỏ qua event không mới hơn (source_version).
   */
  async resyncAll(): Promise<number> {
    const docs = await this.prisma.document.findMany({ select: { docId: true }, orderBy: { docId: 'asc' } });
    const chunk = 100;
    for (let i = 0; i < docs.length; i += chunk) {
      const slice = docs.slice(i, i + chunk);
      await this.prisma.$transaction(async (tx) => {
        for (const d of slice) {
          await this.emitDocumentChanged(tx, d.docId, 'DocumentResynced');
        }
      });
    }
    this.logger.log(`Resync: đã phát ${docs.length} sự kiện DocumentResynced vào outbox`);
    return docs.length;
  }

  /**
   * Dấu vân tay tập tài liệu của phòng để đối soát với Central Index (N3). Không chứa nội dung tài liệu:
   * chỉ số dòng và md5 của chuỗi (doc_id|row_version|status) theo thứ tự doc_id.
   */
  async digest(): Promise<{ count: number; digest: string }> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number; digest: string }>>`
      SELECT COUNT(*)::int AS count,
             COALESCE(md5(string_agg(doc_id::text || '|' || row_version::text || '|' || status, ',' ORDER BY doc_id)), '') AS digest
        FROM document`;
    return rows[0];
  }

  async onApplicationBootstrap() {
    // Lần chạy đầu sau khi nâng cấp: DB có tài liệu cũ nhưng outbox trống -> tự backfill
    if (process.env.OUTBOX_BACKFILL_ON_START !== 'false') {
      try {
        const [outboxCount, docCount] = await Promise.all([
          this.prisma.outbox.count(),
          this.prisma.document.count(),
        ]);
        if (outboxCount === 0 && docCount > 0) {
          this.logger.log(`Outbox trống nhưng có ${docCount} tài liệu: tự động backfill`);
          await this.resyncAll();
        }
      } catch (err) {
        this.logger.error(`Backfill outbox thất bại: ${err.message}`);
      }
    }

    // Dọn outbox: sự kiện đã nằm trong Kafka nên chỉ giữ lại theo thời hạn
    const retentionHours = Number(process.env.OUTBOX_RETENTION_HOURS || 168);
    this.cleanupTimer = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000);
        const res = await this.prisma.outbox.deleteMany({ where: { occurredAt: { lt: cutoff } } });
        if (res.count > 0) this.logger.log(`Đã dọn ${res.count} bản ghi outbox cũ`);
      } catch (err) {
        this.logger.warn(`Dọn outbox lỗi: ${err.message}`);
      }
    }, 10 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}
