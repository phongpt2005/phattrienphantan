import React, { useMemo, useState } from 'react';
import { Download, FileDown, Loader2, Search, Send } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useDepartments } from '../context/DepartmentContext';
import { documentApi, searchApi } from '../services/api';
import { SearchNodeReport, SearchResultItem } from '../types';
import { RequestAccessModal } from './RequestAccessModal';
import { AccessPill, Button, DeptBadge, EmptyState, LoadingRows, PageHeader, Panel, Pill, SELECT, fmtDate, mimeLabel } from './ui';

// Đoạn trích từ ts_headline chỉ chứa thẻ <mark>; phần còn lại là văn bản của tệp nên KHÔNG được chèn như HTML.
const renderSnippet = (snippet: string) =>
  snippet.split(/(<mark>.*?<\/mark>)/g).map((part, i) =>
    part.startsWith('<mark>') ? (
      <mark key={i} className="bg-amber-100 text-slate-900 font-semibold px-0.5 rounded-sm">
        {part.slice(6, -7)}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );

const SUGGESTIONS = ['hợp đồng', 'quy chế', 'hóa đơn', 'bảng lương', 'báo giá'];

const DLP_TOOLTIP = 'Tài liệu được chia sẻ ở chế độ chống thất thoát dữ liệu (DLP). Bạn không có quyền tải file về máy.';

const SEARCH_INPUT =
  'w-full h-10 pl-9 pr-3 rounded-md border border-slate-300 bg-card text-data text-slate-900 placeholder:text-slate-400 hover:border-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';

interface Outcome {
  query: string;
  total: number;
  ms: number;
  fromCache: boolean;
  nodes: SearchNodeReport[];
  traceId: string | null;
  degraded: { centralIndex: boolean; snapshotAgeSeconds: number } | null;
}

/**
 * Tra cứu liên hợp: gửi MỘT truy vấn, Search Gateway hỏi song song mọi node phòng ban.
 * Giao diện cho thấy rõ node nào trả lời trực tiếp, node nào phải lấy từ chỉ mục trung tâm (có thể cũ).
 * Quyền xem do server quyết định theo JWT; ở đây chỉ hiển thị kết quả.
 */
export const SearchTab: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const { departments } = useDepartments();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [requestDoc, setRequestDoc] = useState<{ centralDocId: number; title: string; targetDept: string } | null>(null);

  const run = async (q: string) => {
    const text = q.trim();
    if (!text) {
      toast.warning('Nhập từ khóa tra cứu');
      return;
    }
    setLoading(true);
    try {
      const res = await searchApi.search({ q: text, limit: 50 });
      setResults(res.data || []);
      setOutcome({
        query: text,
        total: res.total,
        ms: res.responseTimeMs,
        fromCache: res.fromCache,
        nodes: res.nodes || [],
        traceId: res.traceId ?? null,
        degraded: res.degraded ?? null,
      });
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Không thực hiện được tìm kiếm', 'Lỗi tra cứu');
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(
    () =>
      results.filter(
        (r) =>
          (deptFilter === 'ALL' || r.dept_code === deptFilter) &&
          (levelFilter === 'ALL' || (levelFilter === 'PUBLIC' ? r.access_level === 'PUBLIC' || r.access_level === 'COMPANY' : r.access_level === levelFilter)),
      ),
    [results, deptFilter, levelFilter],
  );

  const download = (item: SearchResultItem) => {
    toast.info(`Đang tải "${item.title}"`);
    // Qua Search Gateway: kiểm tra quyền (chủ sở hữu hoặc chia sẻ DOWNLOAD), node chủ ghi audit
    const task =
      item.dept_code === user?.departmentCode
        ? documentApi.download(item.dept_code, item.source_doc_id)
        : searchApi.downloadShared(item.dept_code, item.source_doc_id);
    task.catch((e) => toast.error(e.message, 'Không tải được tệp'));
  };

  const exportCsv = () => {
    const header = ['Mã trung tâm', 'Mã nguồn', 'Tiêu đề', 'Phòng ban', 'Bảo mật', 'Quyền của bạn', 'Khớp nội dung tệp'];
    const rows = filtered.map((r) => [
      `#CENTRAL-${r.central_doc_id}`,
      `#DOC-${r.source_doc_id}`,
      r.title,
      r.dept_code,
      r.access_level,
      r.access_mode ?? '',
      r.content_match ? 'có' : 'không',
    ]);
    const csv = '﻿' + [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ket-qua-tra-cuu-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fallbackNodes = outcome?.nodes.filter((n) => n.status !== 'OK') ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tra cứu toàn doanh nghiệp"
        description="Một truy vấn được gửi song song tới mọi phòng ban. Bạn chỉ thấy tài liệu của phòng mình, tài liệu công khai và tài liệu đã được chia sẻ cho phòng bạn."
      />

      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(query);
          }}
          className="p-4 space-y-3"
        >
          <div className="flex gap-2">
            <label className="relative flex-1 min-w-0">
              <Search aria-hidden="true" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Từ khóa trong tiêu đề, mô tả hoặc nội dung tệp (gõ không dấu cũng được)"
                aria-label="Từ khóa tra cứu"
                className={SEARCH_INPUT}
              />
            </label>
            <Button type="submit" variant="primary" disabled={loading} className="h-10 px-4">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Tra cứu'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-slate-500 mr-1">Gợi ý</span>
              {SUGGESTIONS.map((kw) => (
                <button
                  key={kw}
                  type="button"
                  onClick={() => {
                    setQuery(kw);
                    void run(kw);
                  }}
                  className="h-6 px-2 rounded-md border border-slate-200 bg-card hover:bg-slate-50 text-micro font-medium text-slate-700"
                >
                  {kw}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className={SELECT} aria-label="Lọc theo phòng ban">
                <option value="ALL">Mọi phòng ban</option>
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className={SELECT} aria-label="Lọc theo cấp bảo mật">
                <option value="ALL">Mọi cấp bảo mật</option>
                <option value="PUBLIC">Toàn doanh nghiệp</option>
                <option value="DEPARTMENT">Bảo mật phòng ban</option>
              </select>
              <Button type="button" icon={FileDown} disabled={filtered.length === 0} onClick={exportCsv}>
                Xuất CSV
              </Button>
            </div>
          </div>
        </form>
      </Panel>

      {/* Kết quả hợp nhất: node nào đã trả lời */}
      {outcome && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-data text-slate-600">
            <span>
              <strong className="font-mono text-slate-900">{filtered.length}</strong>
              {filtered.length !== outcome.total && <span className="font-mono"> / {outcome.total}</span>} kết quả cho{' '}
              <strong className="text-slate-900">"{outcome.query}"</strong> trong <span className="font-mono">{outcome.ms} ms</span>
              {outcome.fromCache && <span className="text-slate-400"> (từ bộ nhớ đệm)</span>}
            </span>
            <span className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-slate-500">Node</span>
              {outcome.nodes.map((n) => (
                <Pill
                  key={n.code}
                  tone={n.status === 'OK' ? 'success' : n.status === 'UNAVAILABLE' ? 'danger' : 'warning'}
                  title={
                    n.status === 'OK'
                      ? `Trả lời trực tiếp trong ${n.tookMs} ms`
                      : n.status === 'UNAVAILABLE'
                        ? `Không dùng được: ${n.reason ?? 'không rõ'}`
                        : `Không trả lời kịp (${n.reason ?? 'không rõ'}): lấy từ chỉ mục trung tâm`
                  }
                >
                  {n.code} {n.status === 'OK' ? `${n.tookMs} ms` : n.status === 'UNAVAILABLE' ? 'KHÔNG DÙNG ĐƯỢC' : 'DỰ PHÒNG'}
                </Pill>
              ))}
            </span>
            {outcome.traceId && (
              <a
                href={`http://localhost:16686/trace/${outcome.traceId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-micro text-brand-700 hover:underline ml-auto"
                title="Mở vết truy vấn này trên Jaeger (nếu bật tracing)"
              >
                trace {outcome.traceId.slice(0, 8)}
              </a>
            )}
          </div>
          {outcome.degraded && (
            <div className="px-3.5 py-2 rounded-md border border-blue-200 bg-blue-50 text-data text-blue-900">
              <strong>Chỉ mục trung tâm đang ngừng.</strong> Tìm kiếm vẫn chạy trực tiếp tại từng phòng ban nên kết quả của các node đang sống vẫn đầy đủ.
              Tạm thời không có dự phòng khi một node sập. Quyền chia sẻ do node chủ tài liệu tự kiểm tra nên không bị ảnh hưởng.
            </div>
          )}
          {fallbackNodes.length > 0 && (
            <div className="px-3.5 py-2 rounded-md border border-amber-200 bg-amber-50 text-data text-amber-800">
              <strong>Kết quả một phần.</strong> Phòng {fallbackNodes.map((n) => n.code).join(', ')} không phản hồi kịp nên phần của phòng đó lấy từ chỉ mục
              trung tâm: có thể chưa phải bản mới nhất và không tìm được theo nội dung tệp.
            </div>
          )}
        </div>
      )}

      <Panel>
        {loading ? (
          <LoadingRows label="Đang truy vấn các node phòng ban..." />
        ) : !outcome ? (
          <EmptyState
            title="Nhập từ khóa để bắt đầu"
            hint="Ví dụ: một điều khoản trong hợp đồng, một mã tham chiếu hoặc tên người lập. Tìm được cả nội dung bên trong tệp PDF, Word và văn bản."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={`Không có tài liệu nào khớp "${outcome.query}"`}
            hint="Thử từ khóa ngắn hơn hoặc bỏ bộ lọc. Tài liệu của phòng khác chỉ hiện khi công khai hoặc đã được chia sẻ cho phòng bạn."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((r) => {
              const mine = r.dept_code === user?.departmentCode;
              const execView = !mine && r.access_mode === 'OWNER'; // Ban Giám đốc xem tài liệu phòng khác
              const canOpen = mine || execView || r.access_mode === 'SHARED' || r.access_mode === 'PUBLIC';
              // Chỉ được tải khi: tài liệu của phòng mình, Ban Giám đốc, hoặc được chia sẻ ở mức DOWNLOAD (node chủ kiểm tra lại)
              const canDownload = mine || execView || (r.access_mode === 'SHARED' && r.share_permission === 'DOWNLOAD');
              return (
                <li key={`${r.dept_code}-${r.source_doc_id}`} className="px-4 py-3 hover:bg-slate-50/60 transition-colors">
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                        <DeptBadge code={r.dept_code} />
                        <AccessPill level={r.access_level} />
                        {mine ? (
                          <Pill tone="success">PHÒNG TÔI SỞ HỮU</Pill>
                        ) : execView ? (
                          <Pill tone="info" title="Ban Giám đốc có quyền xem mọi tài liệu trên toàn doanh nghiệp">
                            QUYỀN BAN GIÁM ĐỐC
                          </Pill>
                        ) : r.access_mode === 'SHARED' ? (
                          <Pill tone="info">ĐƯỢC CHIA SẺ</Pill>
                        ) : (
                          <Pill tone="neutral">CÔNG KHAI</Pill>
                        )}
                        {r.content_match && (
                          <Pill tone="success" title="Từ khóa nằm trong nội dung bên trong tệp, do content-worker trích và lập chỉ mục tại node của phòng ban">
                            KHỚP TRONG NỘI DUNG TỆP
                          </Pill>
                        )}
                        {r.stale && (
                          <Pill
                            tone="warning"
                            title={`Node không phản hồi kịp: lấy từ chỉ mục trung tâm${r.synced_at ? `, đồng bộ lúc ${new Date(r.synced_at).toLocaleTimeString('vi-VN')}` : ''}`}
                          >
                            TỪ CHỈ MỤC TRUNG TÂM
                          </Pill>
                        )}
                      </div>
                      <h3 className="text-data font-semibold text-slate-900">{r.title}</h3>
                      {r.description && <p className="text-data text-slate-500 mt-0.5 line-clamp-1">{r.description}</p>}
                      {r.content_match && r.highlight_snippet && (
                        <p className="text-data text-slate-600 mt-1.5 pl-2.5 border-l-2 border-emerald-300 line-clamp-2">
                          <span className="text-xs font-medium text-slate-500 mr-1.5">Trích nội dung tệp</span>
                          {renderSnippet(r.highlight_snippet)}
                        </p>
                      )}
                      <div className="flex items-center gap-x-3 gap-y-0.5 mt-1.5 text-micro text-slate-500 font-mono flex-wrap">
                        <span>#DOC-{r.source_doc_id}</span>
                        <span>{r.owner_name || 'Hệ thống'}</span>
                        <span>{fmtDate(r.created_at)}</span>
                        {r.mime_type && <span>{mimeLabel(r.mime_type)}</span>}
                        {r.category_name && <span>{r.category_name}</span>}
                      </div>
                    </div>
                    <div className="shrink-0 pt-0.5">
                      {canDownload ? (
                        <Button size="sm" variant="primary" icon={Download} onClick={() => download(r)}>
                          Tải xuống
                        </Button>
                      ) : canOpen ? (
                        <div className="flex flex-col items-end gap-1.5" title={DLP_TOOLTIP}>
                          <Pill tone="info">CHỈ XEM - DLP</Pill>
                          <Button size="sm" icon={Download} disabled title={DLP_TOOLTIP}>
                            Tải về
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          icon={Send}
                          onClick={() => setRequestDoc({ centralDocId: r.central_doc_id, title: r.title, targetDept: r.dept_code })}
                        >
                          Xin quyền xem
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {requestDoc && (
        <RequestAccessModal
          isOpen
          onClose={() => setRequestDoc(null)}
          centralDocId={requestDoc.centralDocId}
          docTitle={requestDoc.title}
          targetDept={requestDoc.targetDept}
          onSuccess={() => {
            toast.success(`Đã gửi yêu cầu xin quyền "${requestDoc.title}" tới Trưởng phòng ${requestDoc.targetDept}`);
            setRequestDoc(null);
          }}
        />
      )}
    </div>
  );
};
