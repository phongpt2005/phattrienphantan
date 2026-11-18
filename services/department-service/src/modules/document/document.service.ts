import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { PrismaClient, ResilientDatabaseService } from '@dms/database';
import { sanitizeBigInt } from '@dms/common';
import { FileService } from '../file/file.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { CreateDocumentDto } from '../../dto/create-document.dto';
import { UpdateDocumentDto } from '../../dto/update-document.dto';
import { CreateVersionDto } from '../../dto/create-version.dto';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly fileService: FileService,
    private readonly auditService: AuditService,
    private readonly outbox: OutboxService,
    @Optional() private readonly haDb?: ResilientDatabaseService,
  ) {}

  /**
   * Trả về kết nối đọc ưu tiên: Tự động chuyển sang Replica nếu Primary gặp sự cố
   */
  private get readDb(): PrismaClient {
    return this.haDb ? this.haDb.readClient : this.prisma;
  }

  /**
   * Tạo tài liệu mới kèm file phiên bản 1 trong 1 Database Transaction duy nhất
   */
  async create(
    dto: CreateDocumentDto,
    file: Express.Multer.File,
    ipAddress?: string,
    userRole = 'STAFF',
  ) {
    if (!file) {
      throw new BadRequestException('Bắt buộc phải tải lên tệp tài liệu');
    }

    // 1. Upload file vật lý lên MinIO trước
    const fileRecord = await this.fileService.uploadFile(file);

    try {
      // Nếu là Trưởng phòng/Giám đốc tạo thì PUBLISHED ngay; nếu là Nhân viên thì là DRAFT (Chờ phê duyệt ban hành)
      const initialStatus =
        userRole === 'MANAGER' || userRole === 'ADMIN' ? 'PUBLISHED' : 'DRAFT';

      // 2. Ghi metadata vào Database trong Transaction
      const result = await this.prisma.$transaction(async (tx) => {
        // Tạo tài liệu DOCUMENT
        const doc = await tx.document.create({
          data: {
            title: dto.title,
            description: dto.description,
            categoryId: dto.categoryId || null,
            createdBy: BigInt(dto.userId || 1),
            currentVersion: 1,
            status: initialStatus,
            accessLevel: dto.accessLevel || 'DEPARTMENT',
          },
        });

        // Tạo phiên bản đầu tiên DOCUMENT_VERSION
        const version = await tx.documentVersion.create({
          data: {
            docId: doc.docId,
            versionNo: 1,
            fileId: fileRecord.fileId,
            changeNote: 'Khởi tạo tài liệu',
            createdBy: BigInt(dto.userId || 1),
          },
        });

        // Xử lý thẻ Tags (nếu có)
        if (dto.tags) {
          const tagNames = dto.tags
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);

          for (const name of tagNames) {
            let tag = await tx.tag.findUnique({ where: { tagName: name } });
            if (!tag) {
              tag = await tx.tag.create({ data: { tagName: name } });
            }
            await tx.documentTag.create({
              data: {
                docId: doc.docId,
                tagId: tag.tagId,
              },
            });
          }
        }

        // Outbox: ghi sự kiện CÙNG transaction với tài liệu
        await this.outbox.emitDocumentChanged(tx, doc.docId, 'DocumentCreated');

        return { doc, version };
      });

      // 3. Ghi Audit Log tự động
      await this.auditService.log({
        userId: dto.userId || 1,
        docId: result.doc.docId,
        action: 'CREATE',
        detail: `Tạo tài liệu mới "${dto.title}" (phiên bản 1.0)`,
        ipAddress,
      });

      return sanitizeBigInt({
        ...result.doc,
        file: fileRecord,
      });
    } catch (error) {
      this.logger.error(`Lỗi tạo tài liệu: ${error.message}`, error.stack);
      // === COMPENSATING ROLLBACK: Dọn sạch file rác khỏi MinIO S3 ===
      if (fileRecord && fileRecord.storagePath) {
        await this.fileService.deletePhysicalFile(fileRecord.storagePath);
      }
      throw error;
    }
  }

  /**
   * Lấy danh sách tài liệu với phân trang và bộ lọc
   */
  async findAll(query: {
    page?: number;
    limit?: number;
    categoryId?: number;
    status?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.categoryId) where.categoryId = Number(query.categoryId);
    if (query.status) {
      where.status = query.status;
    } else {
      where.status = { not: 'DELETED' }; // Mặc định không hiển thị tài liệu đã xóa
    }

    const [total, documents] = await Promise.all([
      this.readDb.document.count({ where }),
      this.readDb.document.findMany({
        where,
        skip,
        take: limit,
        include: {
          category: true,
          creator: {
            select: { userId: true, username: true, fullName: true },
          },
          documentTags: {
            include: { tag: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return sanitizeBigInt({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: documents,
    });
  }

  /**
   * Xem chi tiết tài liệu kèm toàn bộ lịch sử phiên bản
   */
  async findOne(docId: bigint | number, userId = 1, ipAddress?: string) {
    const document = await this.readDb.document.findUnique({
      where: { docId: BigInt(docId) },
      include: {
        category: true,
        creator: {
          select: { userId: true, username: true, fullName: true },
        },
        documentTags: {
          include: { tag: true },
        },
        versions: {
          include: {
            file: true,
            creator: {
              select: { userId: true, username: true, fullName: true },
            },
          },
          orderBy: { versionNo: 'desc' },
        },
      },
    });

    if (!document) {
      throw new NotFoundException(`Không tìm thấy tài liệu với ID: ${docId}`);
    }

    // Ghi Audit Log hành vi xem tài liệu
    await this.auditService.log({
      userId,
      docId,
      action: 'VIEW',
      detail: `Xem chi tiết tài liệu "${document.title}"`,
      ipAddress,
    });

    return sanitizeBigInt(document);
  }

  /**
   * Cập nhật thông tin tài liệu (Kiểm tra quyền hạn nội bộ phòng ban)
   */
  async update(
    docId: bigint | number,
    dto: UpdateDocumentDto,
    ipAddress?: string,
    user?: any,
  ) {
    const existing = await this.prisma.document.findUnique({
      where: { docId: BigInt(docId) },
    });

    if (!existing) {
      throw new NotFoundException(`Không tìm thấy tài liệu ID: ${docId}`);
    }

    // NGUYÊN TẮC QUẢN TRỊ NỘI BỘ PHÒNG BAN:
    // Nếu là Nhân viên (STAFF): CHỈ ĐƯỢC PHÉP sửa thông tin tài liệu do chính mình tạo ra!
    if (user && user.role === 'STAFF' && existing.createdBy !== BigInt(user.userId)) {
      throw new ForbiddenException(
        'Bạn chỉ có quyền chỉnh sửa tài liệu do chính bạn tạo ra. Với tài liệu của đồng nghiệp khác, chỉ Trưởng phòng mới có thẩm quyền chỉnh sửa.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.document.update({
        where: { docId: BigInt(docId) },
        data: {
          title: dto.title ?? existing.title,
          description: dto.description ?? existing.description,
          categoryId: dto.categoryId !== undefined ? dto.categoryId : existing.categoryId,
          status: dto.status ?? existing.status,
          accessLevel: dto.accessLevel ?? existing.accessLevel,
          updatedAt: new Date(),
        },
      });
      await this.outbox.emitDocumentChanged(tx, row.docId, 'DocumentUpdated');
      return row;
    });

    await this.auditService.log({
      userId: dto.userId || 1,
      docId,
      action: 'UPDATE',
      detail: `Cập nhật thông tin tài liệu "${updated.title}"`,
      ipAddress,
    });

    return sanitizeBigInt(updated);
  }

  /**
   * Tải lên phiên bản mới của tài liệu (Version increment)
   */
  async addVersion(
    docId: bigint | number,
    dto: CreateVersionDto,
    file: Express.Multer.File,
    ipAddress?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn tệp phiên bản mới');
    }

    const doc = await this.prisma.document.findUnique({
      where: { docId: BigInt(docId) },
    });

    if (!doc) {
      throw new NotFoundException(`Không tìm thấy tài liệu ID: ${docId}`);
    }

    const nextVersionNo = doc.currentVersion + 1;

    // 1. Upload file mới lên MinIO
    const fileRecord = await this.fileService.uploadFile(file);

    // 2. Tạo version mới và update currentVersion trên Document
    const result = await this.prisma.$transaction(async (tx) => {
      const version = await tx.documentVersion.create({
        data: {
          docId: doc.docId,
          versionNo: nextVersionNo,
          fileId: fileRecord.fileId,
          changeNote: dto.changeNote || `Cập nhật phiên bản ${nextVersionNo}.0`,
          createdBy: BigInt(dto.userId || 1),
        },
      });

      const updatedDoc = await tx.document.update({
        where: { docId: doc.docId },
        data: {
          currentVersion: nextVersionNo,
          updatedAt: new Date(),
        },
      });

      await this.outbox.emitDocumentChanged(tx, doc.docId, 'DocumentUpdated');

      return { version, updatedDoc };
    });

    // 3. Ghi Audit Log
    await this.auditService.log({
      userId: dto.userId || 1,
      docId,
      action: 'UPDATE',
      detail: `Tải lên phiên bản mới ${nextVersionNo}.0: ${file.originalname}`,
      ipAddress,
    });

    return sanitizeBigInt({
      message: `Tải lên phiên bản ${nextVersionNo} thành công`,
      version: result.version,
      file: fileRecord,
    });
  }

  /**
   * Tải nội dung tệp phiên bản
   */
  async download(
    docId: bigint | number,
    versionNo?: number,
    userId = 1,
    ipAddress?: string,
  ) {
    const doc = await this.readDb.document.findUnique({
      where: { docId: BigInt(docId) },
      include: {
        versions: {
          where: versionNo ? { versionNo: Number(versionNo) } : undefined,
          orderBy: { versionNo: 'desc' },
          take: 1,
          include: { file: true },
        },
      },
    });

    if (!doc || doc.versions.length === 0) {
      throw new NotFoundException('Không tìm thấy tài liệu hoặc phiên bản tương ứng');
    }

    const targetVersion = doc.versions[0];
    const { stream, fileRecord } = await this.fileService.getFileStream(targetVersion.fileId);

    // Ghi audit log
    await this.auditService.log({
      userId,
      docId,
      action: 'DOWNLOAD',
      detail: `Tải xuống tệp "${fileRecord.fileName}" (phiên bản v${targetVersion.versionNo})`,
      ipAddress,
    });

    return { stream, fileRecord, versionNo: targetVersion.versionNo };
  }

  /**
   * Xóa mềm tài liệu (status = 'DELETED') - Chỉ Trưởng phòng / Quản trị viên
   */
  async remove(docId: bigint | number, userId = 1, ipAddress?: string, userRole?: string) {
    if (userRole === 'STAFF') {
      throw new ForbiddenException(
        'Nhân viên không có quyền xóa tài liệu. Chỉ Trưởng phòng mới có thẩm quyền xóa/hủy bỏ hồ sơ phòng ban.',
      );
    }

    const doc = await this.prisma.document.findUnique({
      where: { docId: BigInt(docId) },
    });

    if (!doc) {
      throw new NotFoundException(`Không tìm thấy tài liệu ID: ${docId}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.document.update({
        where: { docId: BigInt(docId) },
        data: {
          status: 'DELETED',
          updatedAt: new Date(),
        },
      });
      await this.outbox.emitDocumentChanged(tx, row.docId, 'DocumentDeleted');
      return row;
    });

    await this.auditService.log({
      userId,
      docId,
      action: 'DELETE',
      detail: `Xóa tài liệu "${doc.title}"`,
      ipAddress,
    });

    return sanitizeBigInt({
      message: 'Xóa tài liệu thành công',
      docId: updated.docId,
      status: updated.status,
    });
  }

  /**
   * Phê duyệt ban hành hồ sơ nội bộ (Dành cho Trưởng phòng / Giám đốc)
   */
  async approveDocument(docId: bigint | number, approverUserId: number, ipAddress?: string) {
    const doc = await this.prisma.document.findUnique({
      where: { docId: BigInt(docId) },
    });

    if (!doc) {
      throw new NotFoundException(`Không tìm thấy tài liệu ID: ${docId}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.document.update({
        where: { docId: BigInt(docId) },
        data: {
          status: 'PUBLISHED',
          updatedAt: new Date(),
        },
        include: {
          creator: { select: { userId: true, username: true, fullName: true } },
          category: true,
        },
      });
      await this.outbox.emitDocumentChanged(tx, row.docId, 'DocumentUpdated');
      return row;
    });

    await this.auditService.log({
      userId: approverUserId,
      docId: BigInt(docId),
      action: 'UPDATE',
      detail: `Trưởng phòng phê duyệt ban hành tài liệu "${doc.title}"`,
      ipAddress,
    });

    return sanitizeBigInt(updated);
  }

  /**
   * Lấy lịch sử vết kiểm toán (Audit Trail) của tài liệu
   */
  async getAuditLogs(docId: bigint | number) {
    const logs = await this.prisma.auditLog.findMany({
      where: { docId: BigInt(docId) },
      include: {
        user: {
          select: {
            userId: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return sanitizeBigInt(logs);
  }
}
