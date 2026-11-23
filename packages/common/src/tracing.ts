/**
 * Distributed tracing (OpenTelemetry). File này được NẠP TRƯỚC ứng dụng:
 *
 *   node -r ./packages/common/dist/tracing.js services/<service>/dist/main.js
 *
 * (phải chạy trước khi http/express/pg được require thì mới gắn được instrumentation).
 * KHÔNG import file này từ index của @dms/common.
 *
 * Bật bằng biến môi trường OTEL_EXPORTER_OTLP_ENDPOINT (ví dụ http://jaeger:4318).
 * Không đặt biến đó thì tracing tắt hoàn toàn, không tốn tài nguyên.
 *
 * Một truy vấn liên hợp tạo MỘT trace xuyên qua nhiều tiến trình:
 *   search-gateway (HTTP vào) ─┬─ federated.query HR  ── HTTP ra ── dept-hr  (HTTP vào, handler)
 *                              ├─ federated.query ACC ── HTTP ra ── dept-acc
 *                              └─ federated.query ...  (node chết: span lỗi + truy vấn pg vào Central Index)
 * Ngữ cảnh trace được truyền giữa các service bằng header W3C `traceparent`.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  if (!process.env.OTEL_SERVICE_NAME) {
    // Node phòng ban: dept-hr, dept-acc, ... (suy ra từ DEPT_CODE nên phòng ban mới tự có tên đúng)
    process.env.OTEL_SERVICE_NAME = process.env.DEPT_CODE ? `dept-${process.env.DEPT_CODE.toLowerCase()}` : 'dms-service';
  }

  const NOISE = /^\/(health|metrics)(\/|$|\?)/;
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(), // đọc OTEL_EXPORTER_OTLP_ENDPOINT, gửi tới <endpoint>/v1/traces
    instrumentations: [
      new HttpInstrumentation({
        // Bỏ healthcheck, Prometheus scrape và luồng SSE (kết nối sống rất lâu)
        ignoreIncomingRequestHook: (req) => NOISE.test(req.url || '') || (req.url || '').includes('/notifications/stream'),
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new UndiciInstrumentation(), // fetch() giữa các service: tự gắn header traceparent
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[tracing] OpenTelemetry bật: service=${process.env.OTEL_SERVICE_NAME} -> ${endpoint}`);

  const stop = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
