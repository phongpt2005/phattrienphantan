import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AuthenticatedUser,
  CircuitBreaker,
  MetricsService,
  SERVICE_TOKEN_HEADER,
  isExecutive,
  requireEnv,
  withTimeout,
} from '@dms/common';
import { RedisCacheService } from '../cache/redis-cache.service';
import { RegisteredDepartment, RegistryService } from '../registry/registry.service';
import { SearchQueryDto } from '../../dto/search-query.dto';
import { SnapshotService } from '../snapshot/snapshot.service';

type NodeStatus = 'OK' | 'FALLBACK' | 'UNAVAILABLE';

interface NodeReport {
  code: string;
  status: NodeStatus;
  tookMs: number;
  reason?: string;
  circuit?: string;
}

interface Hit {
  central_doc_id: number | null;
  department_id: number;
  dept_code: string;
  dept_name: string;
  source_doc_id: number;
  title: string;
  description: string | null;
  category_name: string | null;
  tags: string | null;
  file_name: string | null;
  mime_type: string | null;
  version_no: number;
  owner_name: string | null;
  access_level: string;
  status: string;
  created_at: string;
  synced_at: string | null;
  relevance_score: number;
  highlight_snippet: string;
  access_mode: 'OWNER' | 'SHARED' | 'PUBLIC';
  /** Quyền cao nhất qua chia sẻ còn hiệu lực (do NODE quyết định); null nếu chỉ là công khai/phòng sở hữu */
  share_permission: 'VIEW' | 'DOWNLOAD' | null;
  /** true: lấy từ Central Index vì node không trả lời kịp -> có thể cũ */
  stale: boolean;
  /** true: từ khóa khớp trong NỘI DUNG TỆP (chỉ có khi node trả lời trực tiếp; nội dung không nằm ở Central Index) */
  content_match: boolean;
}

interface NodeResult {
  report: NodeReport;
  hits: Hit[];
  total: number;
}

const RRF_K = 60;
// Không bật tracing (thiếu OTEL_EXPORTER_OTLP_ENDPOINT) thì tracer này là no-op
const tracer = trace.getTracer('dms-federated-search');

/**
 * Federated Search Gateway (R2).
 *
 *  ① Scatter: gọi SONG SONG /internal/search tới mọi phòng ban ACTIVE trong Registry.
 *     Mỗi node có timeout + circuit breaker riêng.
 *  ② Fallback: node chậm/chết/đang DEGRADED -> lấy phần của node đó từ Central Index
 *     (do CDC dựng), gắn stale=true. Chọn Availability thay vì Consistency (AP).
 *  ③ Gather: gộp, khử trùng lặp theo (phòng ban, tài liệu), xếp hạng bằng RRF.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly nodeTimeoutMs = Number(process.env.SEARCH_NODE_TIMEOUT_MS || 800);
  private readonly cacheTtlSec = Number(process.env.SEARCH_RESULT_CACHE_TTL || 30);

  constructor(
    private readonly pool: Pool,
    private readonly cache: RedisCacheService,
    private readonly registry: RegistryService,
    private readonly metrics: MetricsService,
    private readonly snapshots: SnapshotService,
  ) {}

  private breaker(code: string): CircuitBreaker {
    let b = this.breakers.get(code);
    if (!b) {
      b = new CircuitBreaker(code, {
        failureThreshold: Number(process.env.SEARCH_BREAKER_FAILURES || 3),
        resetTimeoutMs: Number(process.env.SEARCH_BREAKER_RESET_MS || 10000),
      });
      this.breakers.set(code, b);
    }
    return b;
  }

  async search(query: SearchQueryDto, viewer: AuthenticatedUser) {
    const started = Date.now();
    const exec = isExecutive(viewer);
    const q = (query.q ?? '').trim();
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const perNode = Math.min(page * limit, 200);

    const cacheKey = `search:${crypto
      .createHash('md5')
      .update(JSON.stringify({ q, d: query.departmentId, c: query.categoryName, m: query.mimeType, page, limit, v: viewer.departmentCode, e: exec }))
      .digest('hex')}`;
    const cached = await this.cache.get<any>(cacheKey);
    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? null;
    if (cached) return { ...cached, fromCache: true, responseTimeMs: Date.now() - started, traceId };

    let depts = await this.registry.listForSearch();
    if (query.departmentId) depts = depts.filter((d) => d.department_id === query.departmentId);

    // Quyền xem do TỪNG NODE tự quyết theo sổ chia sẻ của nó: Gateway không cần (và không giữ) danh sách quyền nào.
    // Trung tâm chỉ ảnh hưởng tới danh bạ phòng ban (bản chụp được) và chỉ mục dự phòng.
    const centralDown = this.registry.registryStale;
    this.metrics.centralDbUp.set(centralDown ? 0 : 1);

    // ① Scatter song song
    const results = await Promise.all(
      depts.map((d) =>
        // Mỗi node là một span con: trên Jaeger thấy các node chạy SONG SONG và node nào phải dùng dự phòng
        tracer.startActiveSpan(`federated.query ${d.dept_code}`, async (span) => {
          try {
            const r = await this.queryDepartment(d, q, perNode, viewer, exec, query);
            span.setAttributes({
              'dms.node': d.dept_code,
              'dms.node.status': r.report.status,
              'dms.node.took_ms': r.report.tookMs,
              'dms.node.hits': r.hits.length,
            });
            if (r.report.status !== 'OK') {
              span.setAttribute('dms.fallback.reason', r.report.reason ?? 'unknown');
              span.setStatus({ code: SpanStatusCode.ERROR, message: `fallback Central Index: ${r.report.reason ?? ''}` });
            }
            return r;
          } finally {
            span.end();
          }
        }),
      ),
    );

    // ③ Gather: RRF + khử trùng lặp
    const scored = new Map<string, { hit: Hit; score: number }>();
    for (const r of results) {
      r.hits.forEach((hit, idx) => {
        const key = `${hit.dept_code}:${hit.source_doc_id}`;
        const score = 1 / (RRF_K + idx + 1);
        const prev = scored.get(key);
        if (!prev || (prev.hit.stale && !hit.stale)) scored.set(key, { hit, score });
      });
    }
    const merged = [...scored.values()]
      .sort((a, b) => b.score - a.score || +new Date(b.hit.created_at) - +new Date(a.hit.created_at))
      .map((x) => x.hit);

    const total = results.reduce((s, r) => s + r.total, 0);
    const partial = results.some((r) => r.report.status !== 'OK');
    for (const r of results) {
      this.metrics.searchNodeDurationSeconds.observe({ node: r.report.code, status: r.report.status }, r.report.tookMs / 1000);
      if (r.report.status !== 'OK') this.metrics.searchFallbackTotal.inc({ node: r.report.code });
    }
    if (partial) this.metrics.searchPartialTotal.inc();
    const response = {
      keyword: q,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      fromCache: false,
      traceId, // tra trên Jaeger: http://localhost:16686/trace/<traceId>
      responseTimeMs: Date.now() - started,
      partial,
      // Chỉ mục trung tâm không đọc được: tìm kiếm vẫn chạy trực tiếp tại các node, chỉ mất khả năng dự phòng
      degraded: centralDown ? { centralIndex: true, snapshotAgeSeconds: Math.round(this.registry.registryAgeMs / 1000) } : null,
      nodes: results.map((r) => r.report),
      viewerContext: { viewerDeptCode: viewer.departmentCode, isExecutive: exec },
      data: merged.slice((page - 1) * limit, page * limit),
    };

    // Kết quả thiếu node (partial) không cache để phục hồi ngay khi node trở lại
    if (!partial && !centralDown) await this.cache.set(cacheKey, response, this.cacheTtlSec);

    this.recordSearchHistory({
      userId: viewer.userId,
      keyword: q,
      filters: { departmentId: query.departmentId, categoryName: query.categoryName, mimeType: query.mimeType, viewerDeptCode: viewer.departmentCode, isExecutive: exec },
      resultCount: total,
      responseTimeMs: response.responseTimeMs,
    }).catch((err) => this.logger.warn(`Không ghi được lịch sử tìm kiếm: ${err.message}`));

    return response;
  }

  private async queryDepartment(
    dept: RegisteredDepartment,
    q: string,
    limit: number,
    viewer: AuthenticatedUser,
    exec: boolean,
    query: SearchQueryDto,
  ): Promise<NodeResult> {
    const started = Date.now();
    const code = dept.dept_code;
    const breaker = this.breaker(code);

    // Node không ở trạng thái ACTIVE (mất heartbeat/đang tắt) -> khỏi chờ timeout, đi thẳng fallback
    if (dept.lifecycle !== 'ACTIVE' || !dept.node_endpoint) {
      return this.fallback(dept, q, limit, viewer, exec, query, started, `lifecycle=${dept.lifecycle}`, breaker);
    }

    try {
      const body = await breaker.exec(() =>
        withTimeout(async (signal) => {
          const res = await fetch(`${dept.node_endpoint}/internal/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [SERVICE_TOKEN_HEADER]: requireEnv('INTERNAL_SERVICE_TOKEN') },
            body: JSON.stringify({
              q,
              limit,
              viewer: { deptCode: viewer.departmentCode, role: viewer.role, userId: viewer.userId, isExecutive: exec },
              filters: { categoryName: query.categoryName, mimeType: query.mimeType },
            }),
            signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as { total: number; hits: any[] };
        }, this.nodeTimeoutMs),
      );

      const centralIds = await this.lookupCentralIds(dept.department_id, body.hits.map((h) => Number(h.source_doc_id)));
      const hits: Hit[] = body.hits.map((h) => ({
        central_doc_id: centralIds.get(Number(h.source_doc_id)) ?? null,
        department_id: dept.department_id,
        dept_code: code,
        dept_name: dept.dept_name,
        source_doc_id: Number(h.source_doc_id),
        title: h.title,
        description: h.description,
        category_name: h.category_name,
        tags: h.tags,
        file_name: h.file_name,
        mime_type: h.mime_type,
        version_no: h.version_no,
        owner_name: h.owner_name,
        access_level: h.access_level,
        status: h.status,
        created_at: h.created_at,
        synced_at: null,
        relevance_score: h.relevance_score,
        highlight_snippet: h.highlight_snippet,
        // Do NODE quyết định: OWNER (phòng sở hữu/Ban Giám đốc) | SHARED (có lượt chia sẻ còn hiệu lực) | PUBLIC
        access_mode: (h.access_via as Hit['access_mode']) ?? (code === viewer.departmentCode || exec ? 'OWNER' : 'PUBLIC'),
        share_permission: h.share_permission ?? null,
        stale: false,
        content_match: h.content_match === true,
      }));
      return { report: { code, status: 'OK', tookMs: Date.now() - started, circuit: breaker.currentState }, hits, total: body.total ?? hits.length };
    } catch (err) {
      return this.fallback(dept, q, limit, viewer, exec, query, started, err.message, breaker);
    }
  }

  private async lookupCentralIds(departmentId: number, sourceIds: number[]): Promise<Map<number, number>> {
    if (sourceIds.length === 0 || this.snapshots.sourceDown) return new Map();
    try {
      const res = await this.pool.query(
        `SELECT source_doc_id, central_doc_id FROM search_document WHERE department_id = $1 AND source_doc_id = ANY($2::bigint[])`,
        [departmentId, sourceIds],
      );
      return new Map(res.rows.map((r) => [Number(r.source_doc_id), Number(r.central_doc_id)]));
    } catch {
      this.snapshots.markDown();
      return new Map(); // trung tâm lỗi: kết quả vẫn trả về, chỉ thiếu mã trung tâm (dùng cho xin quyền/tải liên phòng)
    }
  }

  /** ② Fallback: dùng Central Index cho riêng phòng ban này, gắn stale. */
  private async fallback(
    dept: RegisteredDepartment,
    q: string,
    limit: number,
    viewer: AuthenticatedUser,
    exec: boolean,
    query: SearchQueryDto,
    started: number,
    reason: string,
    breaker: CircuitBreaker,
  ): Promise<NodeResult> {
    this.logger.warn(`Node ${dept.dept_code} dùng fallback Central Index: ${reason}`);
    const canSeeAll = exec || viewer.departmentCode === dept.dept_code;
    if (this.snapshots.sourceDown) {
      return {
        report: { code: dept.dept_code, status: 'UNAVAILABLE', tookMs: Date.now() - started, reason: `${reason}; chỉ mục trung tâm cũng đang ngừng`, circuit: breaker.currentState },
        hits: [],
        total: 0,
      };
    }
    let res;
    try {
      res = await this.pool.query(
      `SELECT d.central_doc_id, d.source_doc_id, d.title, d.description, d.category_name, d.tags, d.file_name,
              d.mime_type, d.version_no, d.owner_name, d.access_level, d.status, d.created_at, d.synced_at, sp.perm AS share_permission,
              CASE WHEN $1 = '' THEN 0 ELSE ts_rank(d.search_vector, plainto_tsquery('vn_unaccent', $1)) END AS relevance_score,
              CASE WHEN $1 = '' THEN COALESCE(d.description, '')
                   ELSE ts_headline('vn_unaccent', COALESCE(d.description, ''), plainto_tsquery('vn_unaccent', $1),
                                    'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') END AS highlight_snippet,
              COUNT(*) OVER ()::int AS total_count
         FROM search_document d
         -- Quyền cao nhất qua chia sẻ còn hiệu lực, đọc từ BẢN SAO sổ chia sẻ của node (nguồn sự thật ở node)
         LEFT JOIN LATERAL (
           SELECT CASE WHEN bool_or(sh->>'permission' = 'DOWNLOAD') THEN 'DOWNLOAD' ELSE 'VIEW' END AS perm
             FROM jsonb_array_elements(d.shares) sh
            WHERE sh->>'sharedWith' IN ($4::varchar, '*') AND NOT COALESCE((sh->>'revoked')::boolean, FALSE)
              AND (sh->>'expiresAt' IS NULL OR (sh->>'expiresAt')::timestamptz > NOW())
           HAVING COUNT(*) > 0
         ) sp ON TRUE
        WHERE d.department_id = $2 AND d.status <> 'DELETED'
          AND ($1 = '' OR d.search_vector @@ plainto_tsquery('vn_unaccent', $1)
               OR unaccent(lower(d.title)) LIKE '%' || unaccent(lower($1)) || '%')
          AND ($3::boolean OR d.access_level = 'PUBLIC' OR sp.perm IS NOT NULL)
          AND ($5::varchar IS NULL OR d.category_name = $5)
          AND ($6::varchar IS NULL OR d.mime_type = $6)
        ORDER BY relevance_score DESC, d.created_at DESC
        LIMIT $7`,
      [q, dept.department_id, canSeeAll, viewer.departmentCode, query.categoryName ?? null, query.mimeType ?? null, limit],
      );
    } catch (err: any) {
      this.snapshots.markDown();
      // Cả node lẫn chỉ mục trung tâm đều không dùng được: phần của phòng này trống, nói rõ trong báo cáo
      return {
        report: { code: dept.dept_code, status: 'UNAVAILABLE', tookMs: Date.now() - started, reason: `${reason}; chỉ mục trung tâm cũng không đọc được`, circuit: breaker.currentState },
        hits: [],
        total: 0,
      };
    }
    const hits: Hit[] = res.rows.map((h) => ({
      central_doc_id: Number(h.central_doc_id),
      department_id: dept.department_id,
      dept_code: dept.dept_code,
      dept_name: dept.dept_name,
      source_doc_id: Number(h.source_doc_id),
      title: h.title,
      description: h.description,
      category_name: h.category_name,
      tags: h.tags,
      file_name: h.file_name,
      mime_type: h.mime_type,
      version_no: h.version_no,
      owner_name: h.owner_name,
      access_level: h.access_level,
      status: h.status,
      created_at: h.created_at,
      synced_at: h.synced_at,
      relevance_score: Number(h.relevance_score),
      highlight_snippet: h.highlight_snippet,
      access_mode: canSeeAll ? 'OWNER' : h.share_permission ? 'SHARED' : 'PUBLIC',
      share_permission: canSeeAll ? null : h.share_permission ?? null,
      stale: true,
      content_match: false,
    }));
    return {
      report: { code: dept.dept_code, status: 'FALLBACK', tookMs: Date.now() - started, reason, circuit: breaker.currentState },
      hits,
      total: res.rows[0]?.total_count ?? 0,
    };
  }

  /** Thống kê số tài liệu theo phòng ban (Central Index). */
  async getStats() {
    const res = await this.pool.query(`
      SELECT dept.department_id, dept.dept_code, dept.dept_name, dept.lifecycle,
             COUNT(d.central_doc_id) AS total_documents, MAX(d.synced_at) AS last_synced_at
        FROM department dept
        LEFT JOIN search_document d ON dept.department_id = d.department_id AND d.status != 'DELETED'
       GROUP BY dept.department_id, dept.dept_code, dept.dept_name, dept.lifecycle
       ORDER BY dept.department_id ASC`);
    return res.rows;
  }

  /**
   * Danh mục tài liệu của CÁC PHÒNG BAN KHÁC để duyệt và xin quyền.
   * Phòng ban lấy từ token; không liệt kê tài liệu PRIVATE (trừ Ban Giám đốc).
   */
  async getCatalog(viewer: AuthenticatedUser) {
    const exec = isExecutive(viewer);
    const res = await this.pool.query(
      `SELECT d.central_doc_id, d.department_id, dept.dept_code, dept.dept_name, d.source_doc_id, d.title,
              d.description, d.category_name, d.file_name, d.mime_type, d.version_no, d.owner_name,
              d.access_level, d.status, d.created_at
         FROM search_document d
         JOIN department dept ON d.department_id = dept.department_id
        WHERE d.status != 'DELETED'
          AND ($1::boolean OR dept.dept_code <> $2)
          AND ($1::boolean OR d.access_level <> 'PRIVATE')
        ORDER BY d.created_at DESC LIMIT 50`,
      [exec, viewer.departmentCode],
    );
    return exec ? res.rows : res.rows.filter((r) => r.dept_code !== viewer.departmentCode);
  }

  private async recordSearchHistory(p: { userId?: number; keyword: string; filters: unknown; resultCount: number; responseTimeMs: number }) {
    await this.pool.query(
      `INSERT INTO search_history (user_id, keyword, filters, result_count, response_time_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [p.userId || null, p.keyword, JSON.stringify(p.filters), p.resultCount, p.responseTimeMs],
    );
  }
}
