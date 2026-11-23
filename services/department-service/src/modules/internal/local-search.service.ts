import { Injectable, Optional } from '@nestjs/common';
import { Prisma, PrismaClient, ResilientDatabaseService } from '@dms/database';
import { requireEnv, sanitizeBigInt } from '@dms/common';

/** Hợp đồng /internal/search v1: mọi node phải tuân theo (Search Gateway phụ thuộc vào đây). */
export interface InternalSearchRequest {
  q: string;
  limit: number;
  viewer: { deptCode: string; role: string; userId?: number; isExecutive: boolean };
  filters?: { categoryName?: string; mimeType?: string };
}

export interface InternalSearchHit {
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
  row_version: number;
  relevance_score: number;
  highlight_snippet: string;
  /** true: từ khóa khớp trong nội dung tệp (không chỉ tiêu đề/mô tả) */
  content_match: boolean;
  content_indexed: boolean;
  /** OWNER: phòng sở hữu hoặc Ban Giám đốc | SHARED: được chia sẻ (xem share_permission) | PUBLIC: công khai, chưa có chia sẻ */
  access_via: 'OWNER' | 'SHARED' | 'PUBLIC';
  /** Quyền cao nhất người xem có qua chia sẻ còn hiệu lực; null nếu không có */
  share_permission: 'VIEW' | 'DOWNLOAD' | null;
}

export interface InternalSearchResponse {
  department_code: string;
  took_ms: number;
  schema_version: 1;
  total: number;
  hits: InternalSearchHit[];
}

@Injectable()
export class LocalSearchService {
  constructor(
    private readonly prisma: PrismaClient,
    @Optional() private readonly haDb?: ResilientDatabaseService,
  ) {}

  private get readDb(): PrismaClient {
    return this.haDb ? this.haDb.readClient : this.prisma;
  }

  /**
   * Tìm kiếm full-text ngay trên DB của node (tiếng Việt có/không dấu).
   * Quyền xem tại node:
   *  - Người cùng phòng ban hoặc Ban Giám đốc: mọi tài liệu chưa xóa.
   *  - Phòng ban khác: tài liệu PUBLIC, hoặc tài liệu có lượt chia sẻ CÒN HIỆU LỰC cho phòng của người xem
   *    (đọc từ sổ document_share CỦA NODE NÀY: node tự quyết định, không phụ thuộc danh sách do Gateway gửi).
   */
  async search(req: InternalSearchRequest): Promise<InternalSearchResponse> {
    const started = Date.now();
    const deptCode = requireEnv('DEPT_CODE');
    const q = req.q.trim();
    const limit = Math.min(Math.max(Number(req.limit) || 10, 1), 200);

    const canSeeAll = req.viewer.isExecutive || req.viewer.deptCode === deptCode;
    // Quyền cao nhất qua chia sẻ còn hiệu lực (hết hạn tính ngay lúc truy vấn). Phòng sở hữu và Ban Giám đốc không cần.
    const sharePerm = canSeeAll
      ? Prisma.sql`NULL::text`
      : Prisma.sql`(SELECT CASE WHEN bool_or(s.permission = 'DOWNLOAD') THEN 'DOWNLOAD' ELSE 'VIEW' END
                      FROM document_share s
                     WHERE s.doc_id = d.doc_id AND NOT s.is_revoked AND (s.expires_at IS NULL OR s.expires_at > NOW())
                       AND s.shared_with_dept IN (${req.viewer.deptCode}, '*')
                    HAVING COUNT(*) > 0)`;
    const visibility = canSeeAll ? Prisma.sql`TRUE` : Prisma.sql`(d.access_level = 'PUBLIC' OR ${sharePerm} IS NOT NULL)`;

    // q rỗng = liệt kê mới nhất (không lọc theo từ khóa)
    const tsq = Prisma.sql`plainto_tsquery('vn_unaccent', ${q})`;
    const metaVec = Prisma.sql`to_tsvector('vn_unaccent', coalesce(d.title, '') || ' ' || coalesce(d.description, ''))`;
    const metaMatch = Prisma.sql`(${metaVec} @@ ${tsq} OR unaccent(lower(d.title)) LIKE '%' || unaccent(lower(${q})) || '%')`;
    // Khớp trong NỘI DUNG TỆP (content_tsv do content-worker lập, có GIN index riêng)
    const contentMatch = q ? Prisma.sql`COALESCE(d.content_tsv @@ ${tsq}, FALSE)` : Prisma.sql`FALSE`;
    const textMatch = q ? Prisma.sql`(${metaMatch} OR ${contentMatch})` : Prisma.sql`TRUE`;
    // Tiêu đề/mô tả nặng hơn nội dung tệp
    const rank = q
      ? Prisma.sql`(ts_rank(${metaVec}, ${tsq}) + 0.4 * COALESCE(ts_rank(d.content_tsv, ${tsq}), 0))::float8`
      : Prisma.sql`0::float8`;
    const hlOpts = Prisma.sql`'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'`;
    const headline = q
      ? Prisma.sql`CASE WHEN ${contentMatch} AND d.content_text IS NOT NULL
                        THEN ts_headline('vn_unaccent', left(d.content_text, 30000), ${tsq}, ${hlOpts})
                        ELSE ts_headline('vn_unaccent', coalesce(d.description, ''), ${tsq}, ${hlOpts}) END`
      : Prisma.sql`coalesce(d.description, '')`;

    const category = req.filters?.categoryName ? Prisma.sql`AND c.name = ${req.filters.categoryName}` : Prisma.empty;
    const mime = req.filters?.mimeType ? Prisma.sql`AND f.mime_type = ${req.filters.mimeType}` : Prisma.empty;

    // Biểu thức tsvector trùng với index idx_document_fts để dùng được GIN
    const rows = await this.readDb.$queryRaw<any[]>(Prisma.sql`
      SELECT
        d.doc_id                  AS source_doc_id,
        d.title,
        d.description,
        c.name                    AS category_name,
        (SELECT string_agg(t.tag_name, ', ')
           FROM document_tag dt JOIN tag t ON t.tag_id = dt.tag_id
          WHERE dt.doc_id = d.doc_id) AS tags,
        f.file_name,
        f.mime_type,
        d.current_version         AS version_no,
        u.full_name               AS owner_name,
        d.access_level,
        d.status,
        d.created_at,
        d.row_version,
        ${rank} AS relevance_score,
        ${headline} AS highlight_snippet,
        ${contentMatch} AS content_match,
        (d.content_indexed_version IS NOT NULL AND d.content_indexed_version = d.current_version) AS content_indexed,
        ${sharePerm}              AS share_permission,
        COUNT(*) OVER ()::int     AS total_count
      FROM document d
      LEFT JOIN category c         ON c.category_id = d.category_id
      LEFT JOIN local_user u       ON u.user_id = d.created_by
      LEFT JOIN document_version v ON v.doc_id = d.doc_id AND v.version_no = d.current_version
      LEFT JOIN file_object f      ON f.file_id = v.file_id
      WHERE ${textMatch}
        AND d.status <> 'DELETED'
        AND ${visibility}
        ${category}
        ${mime}
      ORDER BY relevance_score DESC, d.created_at DESC
      LIMIT ${limit}
    `);

    const hits = sanitizeBigInt(rows) as any[];
    return {
      department_code: deptCode,
      took_ms: Date.now() - started,
      schema_version: 1,
      total: hits[0]?.total_count ?? 0,
      hits: hits.map(({ total_count, source_doc_id, version_no, row_version, ...rest }) => ({
        ...rest,
        access_via: canSeeAll ? 'OWNER' : rest.share_permission ? 'SHARED' : 'PUBLIC',
        source_doc_id: Number(source_doc_id),
        version_no: Number(version_no),
        row_version: Number(row_version),
      })),
    };
  }
}
