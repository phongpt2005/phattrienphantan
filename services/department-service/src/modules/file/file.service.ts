import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, FileObject } from '@dms/database';
import { MinioStorageService, requireEnv } from '@dms/common';
import { Readable } from 'stream';
import * as path from 'path';
import * as crypto from 'crypto';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);
  private storage: MinioStorageService;

  constructor(private readonly prisma: PrismaClient) {
    this.storage = new MinioStorageService({
      endPoint: requireEnv('MINIO_ENDPOINT'),
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: requireEnv('MINIO_ACCESS_KEY'),
      secretKey: requireEnv('MINIO_SECRET_KEY'),
      bucketName: requireEnv('MINIO_BUCKET'),
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    tx?: any,
  ): Promise<FileObject> {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn file tải lên');
    }

    // Giới hạn dung lượng: 50MB
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('Dung lượng file vượt quá giới hạn 50MB');
    }

    // Tạo tên object độc nhất trên MinIO: <năm>/<tháng>/<uuid>_<tên-gốc>
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const ext = path.extname(file.originalname);
    const sanitizedBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const objectName = `${year}/${month}/${Date.now()}_${sanitizedBase}${ext}`;

    // Upload lên MinIO
    const { storagePath, checksumSha256 } = await this.storage.uploadFile(
      objectName,
      file.buffer,
      file.size,
      file.mimetype,
    );

    const client = tx || this.prisma;

    // Lưu thông tin vào FILE_OBJECT. CSDL lỗi (sập, quá tải) thì dọn tệp vừa tải lên, không để tệp mồ côi trong MinIO.
    let fileRecord: FileObject;
    try {
      fileRecord = await client.fileObject.create({
        data: {
          fileName: file.originalname,
          storagePath,
          mimeType: file.mimetype,
          sizeBytes: BigInt(file.size),
          checksumSha256,
        },
      });
    } catch (err) {
      await this.deletePhysicalFile(storagePath);
      throw err;
    }

    this.logger.log(`File uploaded: ${file.originalname} -> ${storagePath} (SHA256: ${checksumSha256})`);
    return fileRecord;
  }

  async getFileStream(fileId: bigint | number): Promise<{ stream: Readable; fileRecord: FileObject }> {
    const fileRecord = await this.prisma.fileObject.findUnique({
      where: { fileId: BigInt(fileId) },
    });

    if (!fileRecord) {
      throw new NotFoundException('Không tìm thấy thông tin file');
    }

    // Tách objectName từ storagePath (bỏ tên bucket ở đầu)
    const parts = fileRecord.storagePath.split('/');
    parts.shift(); // bỏ bucket
    const objectName = parts.join('/');

    const stream = await this.storage.getFileStream(objectName);
    return { stream, fileRecord };
  }

  async getPresignedDownloadUrl(fileId: bigint | number): Promise<string> {
    const fileRecord = await this.prisma.fileObject.findUnique({
      where: { fileId: BigInt(fileId) },
    });

    if (!fileRecord) {
      throw new NotFoundException('Không tìm thấy file');
    }

    const parts = fileRecord.storagePath.split('/');
    parts.shift();
    const objectName = parts.join('/');

    return this.storage.getPresignedDownloadUrl(objectName, 3600);
  }

  /**
   * Dọn dẹp file vật lý trên MinIO S3 khi Transaction Database bị lỗi (Compensating action)
   */
  async deletePhysicalFile(storagePath: string): Promise<void> {
    try {
      const parts = storagePath.split('/');
      parts.shift(); // bỏ bucket
      const objectName = parts.join('/');
      await this.storage.deleteFile(objectName);
      this.logger.warn(`Đã thu hồi & dọn sạch file rác khỏi MinIO S3: ${storagePath}`);
    } catch (err) {
      this.logger.error(`Lỗi khi dọn file mồ côi MinIO (${storagePath}): ${err.message}`);
    }
  }
}
