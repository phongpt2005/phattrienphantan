import { Logger, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Pool } from 'pg';
import { MetricsModule, MetricsInterceptor, requireEnv } from '@dms/common';
import { SearchController } from './modules/search/search.controller';
import { SearchService } from './modules/search/search.service';
import { ProjectorService } from './modules/projector/projector.service';
import { RegistryController } from './modules/registry/registry.controller';
import { RegistryService } from './modules/registry/registry.service';
import { RedisCacheService } from './modules/cache/redis-cache.service';
import { HealthController } from './health.controller';
import { ExecutiveController } from './modules/executive/executive.controller';
import { ExecutiveService } from './modules/executive/executive.service';
import { ShareController } from './modules/share/share.controller';
import { DocumentAccessController } from './modules/share/document-access.controller';
import { ShareService } from './modules/share/share.service';
import { NotificationController } from './modules/notification/notification.controller';
import { NotificationService } from './modules/notification/notification.service';
import { InternalNotifyController } from './modules/notification/internal-notify.controller';
import { MonitoringService } from './modules/monitoring/monitoring.service';
import { SnapshotService } from './modules/snapshot/snapshot.service';
import { ReconcileService } from './modules/reconcile/reconcile.service';
import { ClusterController } from './modules/cluster/cluster.controller';
import { ClusterService } from './modules/cluster/cluster.service';

@Module({
  imports: [MetricsModule],
  controllers: [
    SearchController,
    RegistryController,
    HealthController,
    ExecutiveController,
    ShareController,
    DocumentAccessController,
    NotificationController,
    InternalNotifyController,
    ClusterController,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    {
      // Không còn chuỗi kết nối (kèm mật khẩu) mặc định trong mã nguồn
      provide: Pool,
      useFactory: () => {
        const pool = new Pool({
          connectionString: requireEnv('DATABASE_URL'),
          max: 20,
          idleTimeoutMillis: 30000,
          // Lỗi NHANH khi CSDL không trả lời, để Gateway chuyển sang bản chụp thay vì treo yêu cầu
          connectionTimeoutMillis: Number(process.env.CENTRAL_CONNECT_TIMEOUT_MS || 1200), // kết nối bình thường < 50 ms
          query_timeout: 5000,
        });
        // BẮT BUỘC: không có bộ xử lý này, một kết nối rảnh bị CSDL ngắt sẽ làm CẢ tiến trình Node thoát
        // (đã xảy ra: tắt CSDL trung tâm thì cả hai bản Search Gateway sập, nginx trả 502).
        pool.on('error', (err) => new Logger('CentralPool').warn(`Kết nối CSDL trung tâm lỗi: ${err.message}`));
        return pool;
      },
    },
    SearchService,
    RegistryService,
    ProjectorService,
    RedisCacheService,
    ExecutiveService,
    ShareService,
    NotificationService,
    MonitoringService,
    SnapshotService,
    ReconcileService,
    ClusterService,
  ],
})
export class AppModule {}
