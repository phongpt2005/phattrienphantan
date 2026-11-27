import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, interval, merge } from 'rxjs';
import { filter, finalize, map } from 'rxjs/operators';
import { AuthenticatedUser, MetricsService, isExecutive, keepRedisAlive, redisConnectionOptions } from '@dms/common';

export type NoticeType =
  | 'SHARE_GRANTED'
  | 'SHARE_REVOKED'
  | 'ACCESS_REQUESTED'
  | 'ACCESS_APPROVED'
  | 'ACCESS_REJECTED'
  | 'NODE_DOWN'
  | 'NODE_RECOVERED'
  | 'NODE_JOINED';

export interface Notice {
  id: string;
  type: NoticeType;
  title: string;
  message: string;
  createdAt: string;
  /** Phòng ban nhận ('*' = mọi phòng ban) */
  targetDept: string;
  /** Chỉ các vai trò này nhận (Ban Giám đốc luôn nhận). Bỏ trống = mọi vai trò. */
  roles?: Array<'MANAGER' | 'STAFF' | 'ADMIN'>;
  /** Chỉ đúng người này nhận (vd. người đã gửi yêu cầu) */
  username?: string;
}

const CHANNEL = 'dms:notices';

/**
 * Thông báo thời gian thực qua Server-Sent Events.
 *
 * Search Gateway chạy NHIỀU bản (stateless): người dùng có thể đang nối SSE vào bản A trong khi thao tác
 * chia sẻ/duyệt được xử lý ở bản B. Vì vậy thông báo đi qua Redis pub/sub: bản nào nhận cũng phát lên kênh,
 * mọi bản đều nghe kênh và đẩy cho các kết nối SSE của mình. Mất Redis thì tự lùi về phát trong tiến trình.
 * Mỗi người chỉ nhận thông báo thuộc phòng ban/vai trò của mình (lọc theo JWT ở phía server).
 */
@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private readonly bus = new Subject<Notice>();
  private readonly instance = process.env.HOSTNAME || `pid-${process.pid}`;
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private redisReady = false;
  private keepAlive: Array<{ markClosing: () => void }> = [];
  private seq = 0;

  constructor(private readonly metrics: MetricsService) {}

  onModuleInit() {
    const opts = {
      ...redisConnectionOptions(),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
    };
    this.pub = new Redis({ ...opts, enableOfflineQueue: false });
    this.sub = new Redis(opts);
    for (const c of [this.pub, this.sub]) c.on('error', () => undefined); // lỗi kết nối đã được xử lý bằng fallback
    // Client rơi vào 'end' thì tự nối lại; client nghe kênh đăng ký lại ở sự kiện 'ready' bên dưới
    this.keepAlive = [keepRedisAlive(this.pub), keepRedisAlive(this.sub)];

    this.sub.on('ready', () => {
      this.sub!
        .subscribe(CHANNEL)
        .then(() => {
          this.redisReady = true;
          this.logger.log(`Đã nghe kênh Redis ${CHANNEL} (bản ${this.instance})`);
        })
        .catch(() => (this.redisReady = false));
    });
    this.sub.on('end', () => (this.redisReady = false));
    this.sub.on('message', (_channel, raw) => {
      try {
        this.bus.next(JSON.parse(raw) as Notice);
      } catch {
        /* bỏ qua thông điệp hỏng */
      }
    });
    this.pub.connect().catch(() => undefined);
    this.sub.connect().catch(() => undefined);
  }

  onModuleDestroy() {
    this.keepAlive.forEach((k) => k.markClosing());
    this.pub?.disconnect();
    this.sub?.disconnect();
  }

  publish(n: Omit<Notice, 'id' | 'createdAt'>): void {
    const notice: Notice = { ...n, id: `${this.instance}-${Date.now()}-${++this.seq}`, createdAt: new Date().toISOString() };
    if (this.redisReady && this.pub) {
      // Bản này cũng nhận lại qua kênh, nên không phát trực tiếp để tránh trùng
      this.pub.publish(CHANNEL, JSON.stringify(notice)).catch(() => this.bus.next(notice));
    } else {
      this.bus.next(notice);
    }
  }

  private visibleTo(n: Notice, user: AuthenticatedUser): boolean {
    if (isExecutive(user)) return true;
    if (n.targetDept !== '*' && n.targetDept !== user.departmentCode) return false;
    if (n.username && n.username !== user.username) return false;
    if (n.roles && !n.roles.includes(user.role as any)) return false;
    return true;
  }

  stream(user: AuthenticatedUser): Observable<{ type: string; data: unknown; id?: string }> {
    this.metrics.sseClients.inc();
    const notices = this.bus.pipe(
      filter((n) => this.visibleTo(n, user)),
      map((n) => ({ type: 'notice', data: n, id: n.id })),
    );
    // Nhịp tim 20 giây: giữ kết nối qua proxy và giúp trình duyệt phát hiện đứt kết nối
    const pings = interval(20000).pipe(map(() => ({ type: 'ping', data: { t: Date.now(), instance: this.instance } })));
    return merge(notices, pings).pipe(finalize(() => this.metrics.sseClients.dec()));
  }
}
