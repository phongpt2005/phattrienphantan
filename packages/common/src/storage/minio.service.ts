import * as Minio from 'minio';
import * as crypto from 'crypto';
import { Readable } from 'stream';

export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucketName: string;
}

export class MinioStorageService {
  private client: Minio.Client;
  private bucketName: string;

  constructor(config: MinioConfig) {
    this.client = new Minio.Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.bucketName = config.bucketName;
  }

  /**
   * Đảm bảo bucket lưu trữ tồn tại, nếu chưa có thì tự động tạo
   */
  async ensureBucketExists(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucketName);
    if (!exists) {
      await this.client.makeBucket(this.bucketName, 'us-east-1');
      console.log(`[MinIO] Bucket "${this.bucketName}" created successfully.`);
    }
  }

  /**
   * Upload file lên MinIO từ Buffer hoặc Stream
   */
  async uploadFile(
    objectName: string,
    streamOrBuffer: Buffer | Readable,
    size: number,
    mimeType: string,
  ): Promise<{ storagePath: string; checksumSha256: string }> {
    await this.ensureBucketExists();

    let checksumSha256 = '';

    if (Buffer.isBuffer(streamOrBuffer)) {
      checksumSha256 = crypto
        .createHash('sha256')
        .update(streamOrBuffer)
        .digest('hex');

      await this.client.putObject(
        this.bucketName,
        objectName,
        streamOrBuffer,
        size,
        {
          'Content-Type': mimeType,
          'x-amz-meta-checksum-sha256': checksumSha256,
        },
      );
    } else {
      // Đối với stream, ghi qua PassThrough để vừa tính hash vừa upload
      const hash = crypto.createHash('sha256');
      streamOrBuffer.on('data', (chunk) => hash.update(chunk));

      await this.client.putObject(
        this.bucketName,
        objectName,
        streamOrBuffer,
        size,
        {
          'Content-Type': mimeType,
        },
      );
      checksumSha256 = hash.digest('hex');
    }

    return {
      storagePath: `${this.bucketName}/${objectName}`,
      checksumSha256,
    };
  }

  /**
   * Lấy Stream để đọc file (phục vụ client tải file hoặc streaming)
   */
  async getFileStream(objectName: string): Promise<Readable> {
    return this.client.getObject(this.bucketName, objectName);
  }

  /**
   * Sinh presigned URL cho client tải file trực tiếp trong thời hạn nhất định
   */
  async getPresignedDownloadUrl(
    objectName: string,
    expirySeconds = 3600,
  ): Promise<string> {
    return this.client.presignedGetObject(
      this.bucketName,
      objectName,
      expirySeconds,
    );
  }

  /**
   * Xóa file khỏi storage
   */
  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(this.bucketName, objectName);
  }

  /**
   * Tính hash SHA-256 độc lập của Buffer
   */
  static calculateSha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
