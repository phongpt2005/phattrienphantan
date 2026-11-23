import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { requireEnv } from '@dms/common';

async function bootstrap() {
  const logger = new Logger('SearchEngineService');

  // Fail-fast: thiếu cấu hình bắt buộc thì dừng ngay
  requireEnv('DATABASE_URL');
  requireEnv('JWT_SECRET');
  requireEnv('INTERNAL_SERVICE_TOKEN');
  requireEnv('KAFKA_BROKERS');

  // Kafka consumer (Index Projector) chạy trong ProjectorService bằng kafkajs,
  // tự dò topic dms.dept.<code>.document -> không cần khai báo từng phòng ban.
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));

  const port = process.env.PORT || 3003;
  await app.listen(port);
  logger.log(`Search Engine HTTP Service running on port ${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
});
