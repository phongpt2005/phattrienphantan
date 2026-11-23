import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const startTime = process.hrtime();
    const method = req.method;
    const dept = process.env.DEPT_CODE || 'CENTRAL';

    return next.handle().pipe(
      tap({
        next: () => {
          this.record(method, req.route?.path || req.url, res.statusCode, dept, startTime);
        },
        error: (err) => {
          const statusCode = err.status || err.statusCode || 500;
          this.record(method, req.route?.path || req.url, statusCode, dept, startTime);
        },
      }),
    );
  }

  private record(method: string, route: string, statusCode: number, dept: string, startTime: [number, number]) {
    const diff = process.hrtime(startTime);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    // Chuẩn hóa route (bỏ query string nếu có)
    const normalizedRoute = route ? route.split('?')[0] : 'unknown';

    this.metricsService.httpRequestsTotal.inc({
      method,
      route: normalizedRoute,
      status_code: statusCode.toString(),
      department: dept,
    });

    this.metricsService.httpRequestDurationSeconds.observe(
      {
        method,
        route: normalizedRoute,
        status_code: statusCode.toString(),
        department: dept,
      },
      durationSeconds,
    );
  }
}
