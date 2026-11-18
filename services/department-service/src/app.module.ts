import { Module } from '@nestjs/common';
import { Reflector, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaClient, ResilientDatabaseService } from '@dms/database';
import { MetricsModule, MetricsInterceptor, requireEnv } from '@dms/common';
import { DocumentController } from './modules/document/document.controller';
import { DocumentService } from './modules/document/document.service';
import { CategoryController } from './modules/category/category.controller';
import { CategoryService } from './modules/category/category.service';
import { FileService } from './modules/file/file.service';
import { AuditService } from './modules/audit/audit.service';
import { AuditController } from './modules/audit/audit.controller';
import { OutboxService } from './modules/outbox/outbox.service';
import { RegistryClientService } from './modules/registry/registry-client.service';
import { SeedService } from './modules/seed/seed.service';
import { InternalController } from './modules/internal/internal.controller';
import { LocalSearchService } from './modules/internal/local-search.service';
import { SharesController } from './modules/share/shares.controller';
import { SharesService } from './modules/share/shares.service';
import { HealthController } from './health.controller';
import { SyncController } from './modules/sync/sync.controller';
import { SyncService } from './modules/sync/sync.service';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [AuthModule, MetricsModule],
  controllers: [DocumentController, CategoryController, AuditController, SharesController, InternalController, HealthController, SyncController],
  providers: [
    Reflector,
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    {
      // Không còn URL DB mặc định trong mã nguồn. Replica là tùy chọn: không có thì đọc từ primary.
      provide: ResilientDatabaseService,
      useFactory: () => new ResilientDatabaseService(requireEnv('DATABASE_URL'), process.env.DATABASE_REPLICA_URL || undefined),
    },
    {
      provide: PrismaClient,
      useFactory: (haDb: ResilientDatabaseService) => haDb.writeClient,
      inject: [ResilientDatabaseService],
    },
    FileService,
    AuditService,
    CategoryService,
    OutboxService,
    SharesService,
    DocumentService,
    LocalSearchService,
    RegistryClientService,
    SyncService,
    SeedService,
  ],
})
export class AppModule {}
