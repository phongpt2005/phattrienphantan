import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { requireEnv, setupBigIntSerialization } from '@dms/common';

async function bootstrap() {
  setupBigIntSerialization();

  // Fail-fast: thiếu cấu hình bắt buộc thì dừng ngay, không chạy với giá trị mặc định
  const deptCode = requireEnv('DEPT_CODE');
  requireEnv('DATABASE_URL');
  requireEnv('JWT_SECRET');
  requireEnv('INTERNAL_SERVICE_TOKEN');

  const logger = new Logger(`DepartmentService[${deptCode}]`);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '2mb' }); // content-worker gửi văn bản trích từ tệp

  app.enableCors();
  app.enableShutdownHooks(); // để RegistryClient báo DRAINING khi tắt có trật tự
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  logger.log(`Node phòng ban ${deptCode} đang chạy tại cổng ${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
});
