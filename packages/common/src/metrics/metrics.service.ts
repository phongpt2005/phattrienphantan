import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: client.Registry;

  // Custom metrics
  public readonly httpRequestsTotal: client.Counter<string>;
  public readonly httpRequestDurationSeconds: client.Histogram<string>;
  public readonly documentsTotal: client.Gauge<string>;
  public readonly cacheHitsTotal: client.Counter<string>;
  public readonly cacheMissesTotal: client.Counter<string>;
  public readonly cdcEventsProcessedTotal: client.Counter<string>;
  public readonly searchNodeDurationSeconds: client.Histogram<string>;
  public readonly searchFallbackTotal: client.Counter<string>;
  public readonly searchPartialTotal: client.Counter<string>;
  public readonly sseClients: client.Gauge<string>;
  public readonly snapshotServedTotal: client.Counter<string>;
  public readonly centralDbUp: client.Gauge<string>;

  constructor() {
    this.registry = new client.Registry();

    // 1. Tự động thu thập default Node.js runtime metrics (RAM, CPU, Event loop, GC)
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: 'dms_',
    });

    // 2. Metrics lưu lượng HTTP requests
    this.httpRequestsTotal = new client.Counter({
      name: 'dms_http_requests_total',
      help: 'Tổng số HTTP requests xử lý bởi service',
      labelNames: ['method', 'route', 'status_code', 'department'],
      registers: [this.registry],
    });

    // 3. Metrics độ trễ phản hồi (Response Latency)
    this.httpRequestDurationSeconds = new client.Histogram({
      name: 'dms_http_request_duration_seconds',
      help: 'Thời gian xử lý HTTP request tính bằng giây',
      labelNames: ['method', 'route', 'status_code', 'department'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    // 4. Metrics số lượng tài liệu
    this.documentsTotal = new client.Gauge({
      name: 'dms_documents_total',
      help: 'Số lượng tài liệu phân loại theo trạng thái',
      labelNames: ['department', 'status'],
      registers: [this.registry],
    });

    // 5. Metrics Cache Hit / Miss của Redis
    this.cacheHitsTotal = new client.Counter({
      name: 'dms_redis_cache_hits_total',
      help: 'Tổng số lần tìm kiếm trúng cache Redis',
      registers: [this.registry],
    });

    this.cacheMissesTotal = new client.Counter({
      name: 'dms_redis_cache_misses_total',
      help: 'Tổng số lần tìm kiếm trượt cache (phải truy vấn DB)',
      registers: [this.registry],
    });

    // 6. Metrics sự kiện CDC từ Kafka
    this.cdcEventsProcessedTotal = new client.Counter({
      name: 'dms_cdc_events_processed_total',
      help: 'Tổng số sự kiện CDC đã được đồng bộ',
      labelNames: ['department', 'op', 'status'],
      registers: [this.registry],
    });

    // 7. Federated search: độ trễ từng node và số lần phải dùng Central Index (fallback)
    this.searchNodeDurationSeconds = new client.Histogram({
      name: 'dms_search_node_duration_seconds',
      help: 'Thời gian một node phòng ban trả lời truy vấn liên hợp',
      labelNames: ['node', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1.5],
      registers: [this.registry],
    });
    this.searchFallbackTotal = new client.Counter({
      name: 'dms_search_fallback_total',
      help: 'Số lần một node không trả lời kịp và phải lấy từ Central Index',
      labelNames: ['node'],
      registers: [this.registry],
    });
    this.searchPartialTotal = new client.Counter({
      name: 'dms_search_partial_total',
      help: 'Số truy vấn liên hợp trả về kết quả một phần (có node dùng fallback)',
      registers: [this.registry],
    });
    this.snapshotServedTotal = new client.Counter({
      name: 'dms_snapshot_served_total',
      help: 'Số lần phải dùng bản chụp cũ vì CSDL trung tâm không đọc được',
      labelNames: ['kind', 'source'],
      registers: [this.registry],
    });
    this.centralDbUp = new client.Gauge({
      name: 'dms_central_db_up',
      help: '1 nếu bản Search Gateway này đọc được CSDL trung tâm, 0 nếu không',
      registers: [this.registry],
    });
    this.sseClients = new client.Gauge({
      name: 'dms_sse_clients',
      help: 'Số kết nối thông báo thời gian thực đang mở',
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Metric service sẵn sàng
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
