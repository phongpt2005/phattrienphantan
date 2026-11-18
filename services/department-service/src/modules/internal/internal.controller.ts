import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaClient } from '@dms/database';
import { ServiceTokenGuard } from '@dms/common';
import { InternalSearchRequest, LocalSearchService } from './local-search.service';
import { OutboxService } from '../outbox/outbox.service';
import { FileService } from '../file/file.service';
import { AuditService } from '../audit/audit.service';
import { SharesService } from '../share/shares.service';

/**
 * API nội bộ giữa các thành phần nền tảng (Search Gateway, Share Service) và node.
 * Chỉ nhận service token. Gateway/nginx KHÔNG được publish các đường dẫn /internal/*.
 */
@Controller('internal')
@UseGuards(ServiceTokenGuard)
export class InternalController {
  private readonly logger = new Logger(InternalController.name);
  private readonly dept = process.env.DEPT_CODE ?? '';

  constructor(
    private readonly searchService: LocalSearchService,
    private readonly outbox: OutboxService,
    private readonly files: FileService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaClient,
    private readonly shares: SharesService,
  ) {}

  /** Federated search: tìm trong DB của node này. */
  @Post('search')
  async search(@Body() body: InternalSearchRequest) {
    if (!body || typeof body.q !== 'string') {
      throw new BadRequestException('Thiếu trường q (chuỗi, có thể rỗng)');
    }
    if (!body.viewer || typeof body.viewer.deptCode !== 'string') {
      throw new BadRequestException('Thiếu thông tin người xem');
    }
    return this.searchService.search({
      q: body.q,
      limit: body.limit,
      viewer: {
        deptCode: body.viewer.deptCode,
        role: String(body.viewer.role || 'STAFF'),
        userId: body.viewer.userId,
        isExecutive: body.viewer.isExecutive === true,
      },
      filters: body.filters,
    });
  }

  /** Phát lại toàn bộ tài liệu vào outbox để dựng lại Central Index. */
  @Post('resync')
  async resync() {
    const count = await this.outbox.resyncAll();
    return { replayed: count };
  }

  /**
   * Stream file cho Gateway (tải liên phòng ban). NODE TỰ kiểm tra sổ chia sẻ của mình: phòng khác chỉ được tải khi
   * có lượt chia sẻ DOWNLOAD còn hiệu lực (Ban Giám đốc và phòng sở hữu thì được). Node ghi audit và không bao giờ
   * lộ địa chỉ MinIO ra ngoài. Không truyền viewerDept = lời gọi của hệ thống (content-worker, purpose=index).
   */
  @Get('files/:docId/stream')
  async stream(
    @Param('docId', ParseIntPipe) docId: number,
    @Query('version') version: string | undefined,
    @Query('actor') actor: string | undefined,
    @Query('purpose') purpose: string | undefined,
    @Query('viewerDept') viewerDept: string | undefined,
    @Query('viewerExec') viewerExec: string | undefined,
    @Res() res: Response,
  ) {
    const doc = await this.prisma.document.findUnique({
      where: { docId: BigInt(docId) },
      include: { versions: { where: version ? { versionNo: Number(version) } : undefined, orderBy: { versionNo: 'desc' }, take: 1 } },
    });
    if (!doc || doc.status === 'DELETED' || doc.versions.length === 0) {
      throw new NotFoundException('Không tìm thấy tài liệu hoặc phiên bản');
    }
    // Kiểm tra quyền TRƯỚC khi mở file: thiếu quyền thì không đọc gì từ kho tệp
    if (viewerDept && viewerDept !== process.env.DEPT_CODE && viewerExec !== 'true') {
      const perm = await this.shares.permissionFor(docId, viewerDept);
      if (perm !== 'DOWNLOAD') {
        await this.audit.log({ docId: doc.docId, action: 'VIEW', detail: `Từ chối tải: phòng ${viewerDept} (${actor || 'không rõ'}) ${perm ? 'chỉ có quyền xem' : 'chưa được chia sẻ'}` });
        throw new ForbiddenException(
          perm ? 'Tài liệu này chỉ được xem trực tuyến (CHỈ XEM - DLP), không có quyền tải về' : 'Phòng ban của bạn chưa được cấp quyền tải tài liệu này',
        );
      }
    }
    const target = doc.versions[0];
    // PHÂN LẬP LỖI KHO TỆP: DB của node còn sống (quyền đã kiểm xong) nhưng MinIO của node sập/đầy/mất mạng không
    // phải lỗi phần mềm. Trả 503 + mã riêng để Gateway và người dùng biết đây là sự cố hạ tầng lưu trữ, có thể thử lại.
    let opened: Awaited<ReturnType<FileService['getFileStream']>>;
    try {
      opened = await this.files.getFileStream(target.fileId);
    } catch (storageError) {
      if (storageError instanceof HttpException) throw storageError; // vd. 404 do chính FileService quyết định
      this.logger.error(`Kho MinIO của phòng ${this.dept} không truy cập được khi đọc tài liệu #${docId}: ${(storageError as Error)?.message}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          errorCode: 'STORAGE_NODE_UNAVAILABLE',
          message: `Kho lưu trữ vật lý (MinIO) của phòng ban ${this.dept} tạm thời gián đoạn. Vui lòng thử lại sau.`,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const { stream, fileRecord } = opened;

    // Lập chỉ mục nội dung là truy cập của HỆ THỐNG (vẫn ghi audit), khác với người dùng tải về
    const indexing = purpose === 'index';
    await this.audit.log({
      docId: doc.docId,
      action: indexing ? 'VIEW' : 'DOWNLOAD',
      detail: indexing
        ? `Hệ thống đọc "${fileRecord.fileName}" (v${target.versionNo}) để lập chỉ mục nội dung`
        : `Tải liên phòng ban "${fileRecord.fileName}" (v${target.versionNo}) bởi ${actor || 'không rõ'}`,
    });

    res.set({
      'Content-Type': fileRecord.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileRecord.fileName)}"`,
      'Content-Length': fileRecord.sizeBytes.toString(),
      'X-Checksum-SHA256': fileRecord.checksumSha256,
    });
    // Kho tệp đứt giữa chừng: không thể đổi mã trạng thái nữa (đã gửi tiêu đề) nên ngắt kết nối để client biết tệp hỏng
    stream.on('error', (err) => {
      this.logger.error(`Luồng MinIO đứt giữa chừng khi gửi tài liệu #${docId}: ${err.message}`);
      res.destroy(err);
    });
    stream.pipe(res);
  }

  /**
   * content-worker ghi kết quả trích văn bản của tệp. Nội dung lưu NGAY TẠI node (không lên Central Index).
   * Idempotent theo versionNo; phát sự kiện DocumentUpdated trong cùng transaction (Outbox).
   */
  @Put('documents/:docId/content')
  async putContent(
    @Param('docId', ParseIntPipe) docId: number,
    @Body() body: { versionNo: number; text: string; extractor: string },
  ) {
    const versionNo = Number(body?.versionNo);
    if (!Number.isInteger(versionNo) || typeof body?.text !== 'string') {
      throw new BadRequestException('Cần versionNo (số nguyên) và text (chuỗi)');
    }
    // Postgres không nhận ký tự NUL; giới hạn kích thước để tsvector không vượt 1 MB
    const text = body.text.split(String.fromCharCode(0)).join('').slice(0, 300000);
    const extractor = String(body.extractor || 'unknown').slice(0, 30);
    const updated = await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE document
           SET content_text = ${text},
               content_tsv = to_tsvector('vn_unaccent', ${text}),
               content_indexed_version = ${versionNo},
               content_extractor = ${extractor}
         WHERE doc_id = ${BigInt(docId)} AND status <> 'DELETED' AND current_version = ${versionNo}`;
      if (n > 0) await this.outbox.emitDocumentChanged(tx, BigInt(docId), 'DocumentUpdated');
      return n;
    });
    // updated = 0: tài liệu đã xóa hoặc đã có phiên bản mới hơn -> bỏ qua (sự kiện của phiên bản mới sẽ tới sau)
    return { applied: updated > 0, docId, versionNo, chars: text.length, extractor };
  }

  /** Gateway hỏi: những tài liệu CỦA PHÒNG NÀY đang được chia sẻ cho phòng `dept` (dựng mục "Được chia sẻ với tôi"). */
  @Get('shares/with')
  async sharedWith(@Query('dept') dept: string) {
    if (!dept || !/^[A-Z][A-Z0-9_]{1,19}$/.test(dept)) throw new BadRequestException('Thiếu hoặc sai mã phòng ban (dept)');
    return this.shares.listSharedWith(dept);
  }

  /**
   * Gateway gọi khi Trưởng phòng DUYỆT một yêu cầu xin quyền (yêu cầu nằm ở trung tâm, lượt chia sẻ nằm ở node chủ).
   * Cũng dùng khi chuyển dữ liệu cũ từ sổ trung tâm về node. IDEMPOTENT theo accessRequestId / legacyShareId.
   */
  @Post('shares')
  async grantShare(
    @Body()
    body: {
      docId: number;
      sharedWithDept: string;
      permission?: 'VIEW' | 'DOWNLOAD';
      expiresAt?: string | null;
      reason?: string;
      createdBy?: string;
      source?: 'REQUEST' | 'MIGRATED';
      accessRequestId?: number;
      legacyShareId?: number;
      createdAt?: string;
      isRevoked?: boolean;
    },
  ) {
    const docId = Number(body?.docId);
    if (!Number.isInteger(docId) || docId < 1) throw new BadRequestException('docId không hợp lệ');
    if (!body.sharedWithDept || !/^(\*|[A-Z][A-Z0-9_]{1,19})$/.test(body.sharedWithDept)) throw new BadRequestException('sharedWithDept không hợp lệ');
    if (body.sharedWithDept === process.env.DEPT_CODE) throw new BadRequestException('Không thể chia sẻ cho chính phòng sở hữu');
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new BadRequestException('expiresAt không hợp lệ');
    const source = body.source === 'MIGRATED' ? 'MIGRATED' : 'REQUEST';
    if (source === 'REQUEST' && !body.accessRequestId) throw new BadRequestException('Chia sẻ từ yêu cầu phải kèm accessRequestId');
    const share = await this.shares.grant({
      docId,
      sharedWithDept: body.sharedWithDept,
      permission: body.permission === 'DOWNLOAD' ? 'DOWNLOAD' : 'VIEW',
      expiresAt,
      reason: String(body.reason ?? 'Chia sẻ theo yêu cầu đã duyệt'),
      createdBy: String(body.createdBy ?? 'system'),
      source,
      accessRequestId: body.accessRequestId ? Number(body.accessRequestId) : undefined,
      legacyShareId: body.legacyShareId ? Number(body.legacyShareId) : undefined,
      createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
      isRevoked: body.isRevoked === true,
    });
    return { share };
  }
}
