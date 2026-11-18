import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Admin, Consumer, EachMessagePayload, Kafka, logLevel, Producer } from 'kafkajs';
import { Pool, PoolClient } from 'pg';
import { MetricsService } from '@dms/common';
import { RedisCacheService } from '../cache/redis-cache.service';

/** Hợp đồng sự kiện document v1 do node phát qua Outbox (xem department-service/OutboxService). */
export interface DocumentEvent {
  documentId: number;
  departmentCode?: string;
  title: string;
  description?: string | null;
  categoryName?: string | null;
  tags?: string[];
  fileName?: string | null;
  mimeType?: string | null;
  versionNo?: number;
  ownerName?: string | null;
  accessLevel?: string;
  status: string;
  createdAt?: string;
  rowVersion: number;
  deleted?: boolean;
  /** Bản sao sổ chia sẻ do node phát (nguồn sự thật nằm ở node). Sự kiện cũ chưa có trường này. */
  shares?: Array<{ shareId: number; sharedWith: string; permission: string; expiresAt: string | null; revoked: boolean; createdAt: string }>;
}

const TOPIC_PATTERN = /^dms\.dept\.([a-z0-9_]+)\.document$/;
const DLQ_TOPIC = 'dms.dlq.projector';
const MAX_ATTEMPTS = 3;

/**
 * Index Projector: đọc sự kiện document của MỌI phòng ban và dựng Central Metadata Index.
 *
 * - Subscribe theo pattern `dms.dept.<code>.document`: topic của phòng ban mới tự được nhận,
 *   không cần sửa code (R3). Danh sách topic được dò lại định kỳ.
 * - Exactly-once về hiệu lực: dữ liệu + offset (cdc_partition_progress) ghi trong CÙNG transaction;
 *   event cũ/trùng bị bỏ qua nhờ source_version (= document.row_version ở node).
 * - Lỗi: thử lại tối đa 3 lần, sau đó đẩy vào DLQ `dms.dlq.projector` và đi tiếp (không nghẽn partition).
 */
@Injectable()
export class ProjectorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ProjectorService.name);
  private readonly groupId = process.env.KAFKA_GROUP_ID || 'index-projector';
  private kafka!: Kafka;
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;
  private producer: Producer | null = null;
  private topics: string[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private restarting = false;
  private deptIds = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly cache: RedisCacheService,
    private readonly metrics: MetricsService,
  ) {}

  get status() {
    return { running: this.consumer !== null, groupId: this.groupId, topics: this.topics };
  }

  onApplicationBootstrap() {
    const brokers = (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean);
    if (brokers.length === 0) {
      this.logger.warn('KAFKA_BROKERS chưa cấu hình: Projector không chạy');
      return;
    }
    this.kafka = new Kafka({ clientId: 'dms-index-projector', brokers, logLevel: logLevel.WARN });
    void this.start();
  }

  private async start() {
    let delay = 1000;
    while (!this.stopped) {
      try {
        this.admin = this.kafka.admin();
        await this.admin.connect();
        this.producer = this.kafka.producer();
        await this.producer.connect();
        break;
      } catch (err) {
        this.logger.warn(`Chưa kết nối được Kafka (${err.message}), thử lại sau ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
      }
    }
    await this.refreshSubscriptions();
    const every = Number(process.env.TOPIC_POLL_MS || 5000);
    this.pollTimer = setInterval(() => void this.refreshSubscriptions(), every);
  }

  /** Dò topic phòng ban; có topic mới (phòng ban mới) thì dựng lại consumer với danh sách mới. */
  private async refreshSubscriptions() {
    if (this.stopped || this.restarting || !this.admin) return;
    try {
      const all = await this.admin.listTopics();
      const found = all.filter((t) => TOPIC_PATTERN.test(t)).sort();
      if (found.length === 0 || found.join(',') === this.topics.join(',')) return;

      this.restarting = true;
      this.logger.log(`Danh sách topic thay đổi: [${this.topics.join(', ')}] -> [${found.join(', ')}]`);
      if (this.consumer) {
        try { await this.consumer.disconnect(); } catch { /* bỏ qua */ }
      }
      const consumer = this.kafka.consumer({ groupId: this.groupId, allowAutoTopicCreation: false });
      await consumer.connect();
      for (const topic of found) {
        await consumer.subscribe({ topic, fromBeginning: true });
      }
      // Offset do chính DB quyết định (đã ghi cùng transaction): seek về đó khi được gán partition
      consumer.on(consumer.events.GROUP_JOIN, (e) => {
        const assignment = e.payload.memberAssignment as Record<string, number[]>;
        setImmediate(() => void this.seekToProgress(consumer, assignment));
      });
      await consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handle(payload),
      });
      this.consumer = consumer;
      this.topics = found;
    } catch (err) {
      this.logger.error(`Dựng consumer thất bại: ${err.message}`);
    } finally {
      this.restarting = false;
    }
  }

  private async seekToProgress(consumer: Consumer, assignment: Record<string, number[]>) {
    try {
      for (const [topic, partitions] of Object.entries(assignment)) {
        for (const partition of partitions) {
          const r = await this.pool.query(
            `SELECT last_offset FROM cdc_partition_progress WHERE consumer_group=$1 AND topic=$2 AND partition_id=$3`,
            [this.groupId, topic, partition],
          );
          if (r.rowCount) {
            const next = String(Number(r.rows[0].last_offset) + 1);
            consumer.seek({ topic, partition, offset: next });
            this.logger.log(`Seek ${topic}[${partition}] -> offset ${next} (theo cdc_partition_progress)`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Seek theo progress lỗi (bỏ qua, xử lý idempotent): ${err.message}`);
    }
  }

  private async handle({ topic, partition, message }: EachMessagePayload) {
    const offset = Number(message.offset);
    const code = topic.match(TOPIC_PATTERN)![1].toUpperCase();
    const raw = message.value?.toString('utf8') ?? '';

    let lastError: Error | null = null;
    let infraWaits = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.apply(code, topic, partition, offset, raw);
        await this.commitKafkaOffset(topic, partition, offset);
        if (infraWaits > 0) this.logger.log(`Đã xử lý ${topic}[${partition}]@${offset} sau ${infraWaits} lần chờ CSDL trung tâm hồi phục`);
        return;
      } catch (err) {
        // Lỗi HẠ TẦNG (CSDL trung tâm sập/ngắt kết nối) khác với sự kiện HỎNG. Sự kiện không có lỗi gì,
        // đẩy vào DLQ là mất dữ liệu chỉ mục. Giữ nguyên vị trí, chờ rồi thử lại đến khi CSDL trở lại.
        if (this.isInfrastructureError(err) && !this.stopped) {
          infraWaits++;
          if (infraWaits === 1 || infraWaits % 10 === 0) {
            this.logger.warn(`CSDL trung tâm chưa sẵn sàng (${err.message}); giữ nguyên ${topic}[${partition}]@${offset} và chờ (lần ${infraWaits})`);
          }
          this.metrics.cdcEventsProcessedTotal.inc({ department: code, op: 'wait', status: 'central_down' });
          await new Promise((r) => setTimeout(r, Math.min(500 * infraWaits, 5000)));
          attempt--; // không tính vào số lần thử của sự kiện
          continue;
        }
        lastError = err;
        this.logger.warn(`Xử lý ${topic}[${partition}]@${offset} lần ${attempt}/${MAX_ATTEMPTS} lỗi: ${err.message}`);
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt * attempt));
      }
    }

    // Hết số lần thử: đẩy vào DLQ để không nghẽn partition và không mất sự kiện
    await this.producer!.send({
      topic: DLQ_TOPIC,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: { error: String(lastError?.message).slice(0, 500), sourceTopic: topic, sourcePartition: String(partition), sourceOffset: String(offset) },
        },
      ],
    });
    this.metrics.cdcEventsProcessedTotal.inc({ department: code, op: 'unknown', status: 'dlq' });
    await this.recordFailure(code, topic, partition, offset, raw, lastError!);
    await this.commitKafkaOffset(topic, partition, offset);
    this.logger.error(`Đã chuyển ${topic}[${partition}]@${offset} vào DLQ ${DLQ_TOPIC}: ${lastError?.message}`);
  }

  private isInfrastructureError(err: any): boolean {
    const code = String(err?.code ?? '');
    const msg = String(err?.message ?? '');
    return (
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ||
      /^(08|57P0|53300)/.test(code) ||
      /terminating connection|Connection terminated|connection timeout|timeout exceeded|Client has encountered a connection error|the database system is (starting up|shutting down)|Query read timeout/i.test(msg)
    );
  }

  private async commitKafkaOffset(topic: string, partition: number, offset: number) {
    // Chỉ để Kafka/exporter đo lag; nguồn sự thật là cdc_partition_progress
    await this.consumer?.commitOffsets([{ topic, partition, offset: String(offset + 1) }]).catch(() => undefined);
  }

  private parse(raw: string): DocumentEvent {
    let v: any = JSON.parse(raw);
    if (typeof v === 'string') v = JSON.parse(v); // Event Router có thể phát payload dạng chuỗi JSON
    if (v?.payload && typeof v.payload === 'object' && v.documentId === undefined) v = v.payload;
    if (typeof v?.documentId !== 'number' || typeof v?.rowVersion !== 'number' || !v?.title) {
      throw new Error('Sự kiện document không đúng hợp đồng v1');
    }
    return v as DocumentEvent;
  }

  private async departmentId(client: PoolClient, code: string): Promise<number> {
    const cached = this.deptIds.get(code);
    if (cached) return cached;
    // Event có thể tới trước khi node kịp đăng ký: tạo bản ghi PROVISIONING, node đăng ký sau sẽ cập nhật
    await client.query(
      `INSERT INTO department (dept_code, dept_name, node_endpoint, kafka_topic, status, lifecycle)
       VALUES ($1, $1, '', $2, 'ACTIVE', 'PROVISIONING') ON CONFLICT (dept_code) DO NOTHING`,
      [code, `dms.dept.${code.toLowerCase()}.document`],
    );
    const r = await client.query(`SELECT department_id FROM department WHERE dept_code = $1`, [code]);
    this.deptIds.set(code, r.rows[0].department_id);
    return r.rows[0].department_id;
  }

  private async apply(code: string, topic: string, partition: number, offset: number, raw: string) {
    const ev = this.parse(raw);
    if (ev.departmentCode && ev.departmentCode.toUpperCase() !== code) {
      throw new Error(`departmentCode "${ev.departmentCode}" không khớp topic ${topic}`);
    }
    const client = await this.pool.connect();
    let applied = false;
    try {
      await client.query('BEGIN');
      const deptId = await this.departmentId(client, code);

      // Upsert có điều kiện: event cũ/trùng (source_version không mới hơn) bị bỏ qua
      const up = await client.query(
        `INSERT INTO search_document (
            department_id, source_doc_id, title, description, category_name, tags, file_name, mime_type,
            version_no, owner_name, access_level, status, created_at, source_version, shares, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamp, NOW()),$14,$15::jsonb,NOW())
         ON CONFLICT (department_id, source_doc_id) DO UPDATE SET
            title = EXCLUDED.title, description = EXCLUDED.description,
            category_name = EXCLUDED.category_name, tags = EXCLUDED.tags,
            file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type,
            version_no = EXCLUDED.version_no, owner_name = EXCLUDED.owner_name,
            access_level = EXCLUDED.access_level, status = EXCLUDED.status,
            source_version = EXCLUDED.source_version, shares = EXCLUDED.shares, synced_at = NOW()
         WHERE search_document.source_version < EXCLUDED.source_version
         RETURNING central_doc_id`,
        [
          deptId,
          ev.documentId,
          ev.title,
          ev.description ?? null,
          ev.categoryName ?? null,
          ev.tags && ev.tags.length ? ev.tags.join(', ').slice(0, 500) : null,
          ev.fileName ?? null,
          ev.mimeType ?? null,
          ev.versionNo ?? 1,
          ev.ownerName ?? null,
          ev.accessLevel ?? 'DEPARTMENT',
          ev.deleted ? 'DELETED' : ev.status,
          ev.createdAt ?? null,
          ev.rowVersion,
          JSON.stringify(ev.shares ?? []),
        ],
      );
      applied = (up.rowCount ?? 0) > 0;

      await client.query(
        `INSERT INTO sync_event_log (department_id, source_doc_id, event_type, kafka_partition, kafka_offset,
                                     payload, process_status, received_at, processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())`,
        [
          deptId,
          ev.documentId,
          ev.deleted ? 'DELETE' : ev.rowVersion <= 1 ? 'INSERT' : 'UPDATE',
          partition,
          offset,
          JSON.stringify(ev),
          applied ? 'DONE' : 'SKIPPED',
        ],
      );

      // Offset ghi CÙNG transaction: không bao giờ "đã xử lý mà chưa lưu offset" hay ngược lại
      await client.query(
        `INSERT INTO cdc_partition_progress (consumer_group, topic, partition_id, last_offset, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (consumer_group, topic, partition_id)
         DO UPDATE SET last_offset = GREATEST(cdc_partition_progress.last_offset, EXCLUDED.last_offset), updated_at = NOW()`,
        [this.groupId, topic, partition, offset],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    this.metrics.cdcEventsProcessedTotal.inc({ department: code, op: ev.deleted ? 'delete' : 'upsert', status: applied ? 'applied' : 'skipped' });
    if (applied) await this.cache.invalidateSearchCache();
  }

  private async recordFailure(code: string, topic: string, partition: number, offset: number, raw: string, err: Error) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deptId = await this.departmentId(client, code);
      await client.query(
        `INSERT INTO sync_event_log (department_id, event_type, kafka_partition, kafka_offset, payload,
                                     process_status, error_message, received_at)
         VALUES ($1,'UPDATE',$2,$3,$4,'DLQ',$5,NOW())`,
        [deptId, partition, offset, JSON.stringify({ raw: raw.slice(0, 2000) }), String(err.message).slice(0, 500)],
      );
      await client.query(
        `INSERT INTO cdc_partition_progress (consumer_group, topic, partition_id, last_offset, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (consumer_group, topic, partition_id)
         DO UPDATE SET last_offset = GREATEST(cdc_partition_progress.last_offset, EXCLUDED.last_offset), updated_at = NOW()`,
        [this.groupId, topic, partition, offset],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error(`Không ghi được sync_event_log cho event lỗi: ${e.message}`);
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.consumer?.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
  }
}
