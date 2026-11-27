import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { documentApi, searchApi } from '../services/api';
import { DocumentItem, SharedDocumentItem, AccessRequestItem } from '../types';
import { useToast } from '../context/ToastContext';
import {
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileCheck,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder,
  HardDrive,
  Info,
  LayoutGrid,
  List,
  Lock,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { UploadModal } from './UploadModal';
import { ShareModal } from './ShareModal';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { SharedDocDetailDrawer } from './SharedDocDetailDrawer';
import { RequestAccessModal } from './RequestAccessModal';
import {
  AccessPill,
  Button,
  DeptBadge,
  DocStatusPill,
  EmptyState,
  IconButton,
  LoadingRows,
  PermissionPill,
  RequestStatusPill,
  ROW,
  SELECT,
  SearchField,
  Segmented,
  Td,
  Th,
  fmtDate,
  fmtNumber,
} from './ui';

type DriveNavSection = 'MY_DRIVE' | 'SHARED_WITH_ME' | 'APPROVALS' | 'CONFIDENTIAL' | 'COMPANY';
type StatusFilter = 'ALL' | 'DRAFT' | 'PUBLISHED';
type TypeFilter = 'ALL' | 'PDF' | 'EXCEL' | 'DOC';
type ViewMode = 'LIST' | 'GRID';

const categoryOf = (d: DocumentItem) => d.category?.name || d.category?.categoryName || '';

/** Biểu tượng theo loại tệp, đoán từ đuôi tên. */
const fileIcon = (title: string, className: string) => {
  const lower = title.toLowerCase();
  if (lower.endsWith('.pdf')) return <FileText className={`${className} text-red-600`} />;
  if (/\.(xlsx|xls|csv)$/.test(lower)) return <FileSpreadsheet className={`${className} text-emerald-700`} />;
  if (/\.(docx|doc)$/.test(lower)) return <FileCheck className={`${className} text-blue-700`} />;
  if (/\.(json|xml|sql)$/.test(lower)) return <FileCode className={`${className} text-amber-700`} />;
  return <File className={`${className} text-slate-500`} />;
};

const NavRow: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  countTone?: 'default' | 'warning';
}> = ({ active, onClick, icon: Icon, label, count, countTone = 'default' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'true' : undefined}
    className={`w-full h-8 flex items-center gap-2.5 px-2.5 rounded-md text-data text-left transition-colors ${
      active ? 'bg-brand-50 text-brand-800 font-semibold' : 'text-slate-700 font-medium hover:bg-slate-100'
    }`}
  >
    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-brand-600' : 'text-slate-400'}`} />
    <span className="truncate flex-1">{label}</span>
    {count !== undefined && (
      <span
        className={`inline-flex items-center h-4 px-1.5 rounded font-mono text-micro ${
          countTone === 'warning'
            ? 'bg-amber-100 text-amber-800 font-semibold'
            : active
            ? 'bg-card text-brand-700'
            : 'bg-slate-100 text-slate-600'
        }`}
      >
        {count}
      </span>
    )}
  </button>
);

const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3 px-3 h-9">
    <dt className="text-xs font-medium text-slate-500 whitespace-nowrap">{label}</dt>
    <dd className="text-data text-slate-800 min-w-0 truncate text-right">{children}</dd>
  </div>
);

export const WorkspaceTab: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const currentDept = user?.departmentCode ?? '';
  const isManagerOrExec = user?.role === 'MANAGER' || !!user?.isExecutive;

  // Điều hướng và bộ lọc
  const [activeSection, setActiveSection] = useState<DriveNavSection>('MY_DRIVE');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('LIST');
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // Dữ liệu
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [sharedDocs, setSharedDocs] = useState<SharedDocumentItem[]>([]);
  // Node phòng ban không trả lời khi gom "được chia sẻ với tôi" (kết quả chỉ một phần)
  const [unavailableNodes, setUnavailableNodes] = useState<string[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Tệp đang chọn và các cửa sổ phụ
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [selectedSharedDoc, setSelectedSharedDoc] = useState<SharedDocumentItem | null>(null);
  const [drawerDocId, setDrawerDocId] = useState<number | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isRequestAccessOpen, setIsRequestAccessOpen] = useState(false);
  const [shareDoc, setShareDoc] = useState<{ id: number; title: string } | null>(null);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const internalRes = await documentApi.getDocuments(currentDept, 1, 150);
      setDocuments(internalRes.data || []);

      const sharedRes = await searchApi.getSharedWithMe(currentDept);
      setSharedDocs(sharedRes?.shares || []);
      setUnavailableNodes(sharedRes?.isPartial ? sharedRes.unavailableNodes : []);

      if (isManagerOrExec) {
        const reqRes = await searchApi.getAccessRequests(currentDept, !!user?.isExecutive);
        setAccessRequests(reqRes || []);
      }
    } catch (err: any) {
      console.error('Lỗi nạp dữ liệu workspace:', err);
      toast.error('Không thể đồng bộ hồ sơ phòng ban', 'Lỗi kết nối');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.token) {
      fetchData();
    }
  }, [user?.departmentCode, user?.token, user?.role]);

  const handleDownload = (docId: number) => {
    documentApi.download(currentDept, docId).catch((e) => toast.error(e.message, 'Lỗi tải tệp'));
    toast.info(`Đang tải tệp hồ sơ #DOC-${docId}`);
  };

  /** Cấp quyền cho yêu cầu chia sẻ: (mã yêu cầu, người duyệt, quyền). Cùng cách gọi với màn Phê duyệt. */
  const approve = async (requestId: number, permission: 'VIEW' | 'DOWNLOAD') => {
    try {
      await searchApi.approveAccessRequest(requestId, user?.username || '', permission);
      toast.success(permission === 'DOWNLOAD' ? 'Đã cấp quyền TẢI VỀ cho văn bản' : 'Đã cấp quyền XEM cho văn bản');
      fetchData();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Không cấp được quyền', 'Lỗi phê duyệt');
    }
  };

  const categories = useMemo(() => Array.from(new Set(documents.map(categoryOf).filter(Boolean))), [documents]);
  const pendingRequests = accessRequests.filter((r) => r.status === 'PENDING').length;

  const filteredDocs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return documents.filter((d) => {
      // Phạm vi theo mục điều hướng
      if (activeSection === 'CONFIDENTIAL' && d.accessLevel !== 'CONFIDENTIAL') return false;
      if (activeSection === 'COMPANY' && d.accessLevel !== 'COMPANY') return false;
      // Thư mục nghiệp vụ
      if (selectedCategory !== 'ALL' && categoryOf(d) !== selectedCategory) return false;
      // Trạng thái
      if (statusFilter !== 'ALL' && d.status !== statusFilter) return false;
      // Loại tệp theo đuôi tên
      if (typeFilter !== 'ALL') {
        const lower = d.title.toLowerCase();
        if (typeFilter === 'PDF' && !lower.endsWith('.pdf')) return false;
        if (typeFilter === 'EXCEL' && !/\.(xlsx|xls|csv)$/.test(lower)) return false;
        if (typeFilter === 'DOC' && !/\.(docx|doc)$/.test(lower)) return false;
      }
      // Từ khóa: tên, mã, thư mục, người tạo
      if (q) {
        const hit =
          d.title.toLowerCase().includes(q) ||
          `doc-${d.docId}`.includes(q) ||
          categoryOf(d).toLowerCase().includes(q) ||
          (d.creator?.fullName || d.creator?.username || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [documents, activeSection, selectedCategory, statusFilter, typeFilter, searchQuery]);

  // Tệp hiển thị ở ngăn chi tiết: tệp đã chọn, nếu chưa chọn thì tệp đầu danh sách
  const activeSelectedDoc = useMemo(() => {
    if (!selectedDocId) return filteredDocs[0] || null;
    return documents.find((d) => d.docId === selectedDocId) || null;
  }, [selectedDocId, documents, filteredDocs]);

  const isDocSection = activeSection === 'MY_DRIVE' || activeSection === 'CONFIDENTIAL' || activeSection === 'COMPANY';
  const showInspector = isInspectorOpen && isDocSection && !!activeSelectedDoc;

  const selectSection = (section: DriveNavSection) => {
    setActiveSection(section);
    setSelectedCategory('ALL');
  };

  const selectCategory = (cat: string) => {
    if (!isDocSection) setActiveSection('MY_DRIVE');
    setSelectedCategory(cat);
  };

  const stats: Array<{ label: string; value: number; tone: string }> = [
    { label: 'Tài liệu của phòng', value: documents.length, tone: 'text-slate-900' },
    { label: 'Đã ban hành', value: documents.filter((d) => d.status === 'PUBLISHED').length, tone: 'text-emerald-700' },
    { label: 'Bản nháp', value: documents.filter((d) => d.status === 'DRAFT').length, tone: 'text-amber-700' },
    { label: 'Được chia sẻ', value: sharedDocs.length, tone: 'text-slate-900' },
  ];
  if (isManagerOrExec) {
    stats.push({ label: 'Yêu cầu chờ duyệt', value: pendingRequests, tone: pendingRequests > 0 ? 'text-amber-700' : 'text-slate-900' });
  }

  const sectionTitle: Record<DriveNavSection, string> = {
    MY_DRIVE: currentDept ? `Kho phòng ${currentDept}` : 'Kho phòng ban',
    SHARED_WITH_ME: 'Được chia sẻ đến phòng',
    APPROVALS: 'Yêu cầu chia sẻ',
    CONFIDENTIAL: 'Tài liệu mật (DLP)',
    COMPANY: 'Toàn doanh nghiệp',
  };

  const renderDocActions = (doc: DocumentItem) => (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <IconButton size="sm" ghost title="Tải tệp về máy" aria-label="Tải tệp về máy" onClick={() => handleDownload(doc.docId)}>
        <Download className="w-3.5 h-3.5" />
      </IconButton>
      {isManagerOrExec && (
        <IconButton
          size="sm"
          ghost
          title="Chia sẻ liên phòng"
          aria-label="Chia sẻ liên phòng"
          onClick={() => setShareDoc({ id: doc.docId, title: doc.title })}
        >
          <Share2 className="w-3.5 h-3.5" />
        </IconButton>
      )}
      <IconButton size="sm" ghost title="Mở chi tiết đầy đủ" aria-label="Mở chi tiết đầy đủ" onClick={() => setDrawerDocId(doc.docId)}>
        <ExternalLink className="w-3.5 h-3.5" />
      </IconButton>
    </div>
  );

  const renderDocTable = () => (
    <table className="w-full table-fixed border-collapse">
      <thead className="sticky top-0 z-10">
        <tr>
          <Th className="pl-4 w-24">Mã hồ sơ</Th>
          <Th>Tên tài liệu</Th>
          <Th className="hidden lg:table-cell w-36">Phân loại</Th>
          <Th className="w-28">Trạng thái</Th>
          <Th className="hidden 2xl:table-cell w-20">Phiên bản</Th>
          <Th className="hidden md:table-cell w-24">Cập nhật</Th>
          <Th className="pr-3 w-24 text-right">Thao tác</Th>
        </tr>
      </thead>
      <tbody>
        {filteredDocs.map((doc) => {
          const isSelected = activeSelectedDoc?.docId === doc.docId;
          return (
            <tr
              key={doc.docId}
              onClick={() => setSelectedDocId(doc.docId)}
              onDoubleClick={() => setDrawerDocId(doc.docId)}
              className={`${ROW} cursor-pointer ${isSelected ? 'bg-brand-50/70' : ''}`}
            >
              <Td className={`pl-4 font-mono text-micro text-slate-500 whitespace-nowrap ${isSelected ? 'shadow-[inset_2px_0_0_0_#0064e0]' : ''}`}>
                #DOC-{doc.docId}
              </Td>
              <Td className="w-full max-w-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  {fileIcon(doc.title, 'w-4 h-4 shrink-0')}
                  <span className="truncate font-medium text-slate-900" title={doc.title}>
                    {doc.title}
                  </span>
                </div>
              </Td>
              <Td className="hidden lg:table-cell">
                <AccessPill level={doc.accessLevel} />
              </Td>
              <Td>
                <DocStatusPill status={doc.status} />
              </Td>
              <Td className="hidden 2xl:table-cell font-mono text-micro text-slate-600">v{doc.currentVersion}.0</Td>
              <Td className="hidden md:table-cell font-mono text-micro text-slate-500 whitespace-nowrap">
                {fmtDate(doc.updatedAt || doc.createdAt)}
              </Td>
              <Td className="pr-3">{renderDocActions(doc)}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const renderDocGrid = () => (
    <div className="p-4 grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {filteredDocs.map((doc) => {
        const isSelected = activeSelectedDoc?.docId === doc.docId;
        return (
          <article
            key={doc.docId}
            onClick={() => setSelectedDocId(doc.docId)}
            onDoubleClick={() => setDrawerDocId(doc.docId)}
            className={`rounded-xl border bg-card p-3 cursor-pointer transition-colors flex flex-col gap-3 ${
              isSelected ? 'border-brand-400 ring-2 ring-brand-500/15' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="w-9 h-9 rounded-md bg-slate-50 border border-slate-200 flex items-center justify-center shrink-0">
                {fileIcon(doc.title, 'w-4 h-4')}
              </div>
              <DocStatusPill status={doc.status} />
            </div>
            <div className="min-w-0">
              <div className="text-data font-semibold text-slate-900 truncate" title={doc.title}>
                {doc.title}
              </div>
              <div className="mt-0.5 font-mono text-micro text-slate-500 truncate">
                #DOC-{doc.docId} · v{doc.currentVersion}.0
              </div>
            </div>
            <div className="mt-auto pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
              <AccessPill level={doc.accessLevel} />
              {renderDocActions(doc)}
            </div>
          </article>
        );
      })}
    </div>
  );

  const renderShared = () =>
    sharedDocs.length === 0 ? (
      <EmptyState
        title={unavailableNodes.length > 0 ? 'Chưa lấy được văn bản chia sẻ nào' : 'Chưa có văn bản nào được chia sẻ đến phòng'}
        hint={
          unavailableNodes.length > 0
            ? 'Một số phòng ban đang không phản hồi, nên danh sách có thể chưa đầy đủ.'
            : 'Khi phòng khác cấp quyền xem hoặc tải tài liệu cho phòng bạn, tài liệu sẽ hiện ở đây.'
        }
      />
    ) : (
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            <Th className="pl-4">Tên tài liệu</Th>
            <Th>Phòng chia sẻ</Th>
            <Th>Quyền hạn</Th>
            <Th className="hidden md:table-cell">Hết hạn</Th>
            <Th className="pr-4 text-right">Thao tác</Th>
          </tr>
        </thead>
        <tbody>
          {sharedDocs.map((item) => (
            <tr key={item.share_id} onClick={() => setSelectedSharedDoc(item)} className={`${ROW} cursor-pointer`}>
              <Td className="pl-4 w-full max-w-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  {fileIcon(item.title || '', 'w-4 h-4 shrink-0')}
                  <span className="truncate font-medium text-slate-900" title={item.title}>
                    {item.title || `Văn bản #${item.source_doc_id}`}
                  </span>
                </div>
              </Td>
              <Td>
                <DeptBadge code={item.shared_by_dept} />
              </Td>
              <Td>
                <PermissionPill permission={item.permission} />
              </Td>
              <Td className="hidden md:table-cell font-mono text-micro text-slate-500 whitespace-nowrap">
                {item.expires_at ? fmtDate(item.expires_at) : 'Không thời hạn'}
              </Td>
              <Td className="pr-4 text-right">
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedSharedDoc(item);
                  }}
                >
                  Xem chi tiết
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  const renderApprovals = () =>
    accessRequests.length === 0 ? (
      <EmptyState
        title="Không có yêu cầu cấp quyền nào"
        hint="Khi phòng khác xin quyền tới tài liệu của phòng bạn, yêu cầu sẽ hiện ở đây."
      />
    ) : (
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            <Th className="pl-4 w-28">Mã hồ sơ</Th>
            <Th>Văn bản</Th>
            <Th>Phòng xin quyền</Th>
            <Th className="hidden lg:table-cell">Lý do</Th>
            <Th className="hidden md:table-cell">Quyền xin</Th>
            <Th>Trạng thái</Th>
            <Th className="pr-4 text-right">Thao tác</Th>
          </tr>
        </thead>
        <tbody>
          {accessRequests.map((req) => (
            <tr key={req.request_id} className={ROW}>
              <Td className="pl-4 font-mono text-micro text-slate-500 whitespace-nowrap">#DOC-{req.central_doc_id}</Td>
              <Td className="w-full max-w-0">
                <span className="block truncate font-medium text-slate-900" title={req.title}>
                  {req.title || `Văn bản #${req.central_doc_id}`}
                </span>
              </Td>
              <Td>
                <div className="flex items-center gap-2 min-w-0">
                  <DeptBadge code={req.requester_dept} />
                  <span className="truncate text-slate-600">{req.requester_username}</span>
                </div>
              </Td>
              <Td className="hidden lg:table-cell max-w-[220px]">
                <span className="block truncate text-slate-600" title={req.reason}>
                  {req.reason || '—'}
                </span>
              </Td>
              <Td className="hidden md:table-cell">
                {req.requested_permission ? <PermissionPill permission={req.requested_permission} /> : <span className="text-slate-400">—</span>}
              </Td>
              <Td>
                <RequestStatusPill status={req.status} />
              </Td>
              <Td className="pr-4">
                {req.status === 'PENDING' ? (
                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" onClick={() => void approve(req.request_id, 'VIEW')}>
                      Cấp quyền xem
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => void approve(req.request_id, 'DOWNLOAD')}>
                      Cấp quyền tải
                    </Button>
                  </div>
                ) : (
                  <div className="text-right font-mono text-micro text-slate-500">{fmtDate(req.reviewed_at)}</div>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  const countText =
    activeSection === 'SHARED_WITH_ME'
      ? `${sharedDocs.length} tài liệu`
      : activeSection === 'APPROVALS'
      ? `${accessRequests.length} yêu cầu`
      : `${filteredDocs.length} tài liệu`;

  return (
    <div className="flex flex-1 min-h-0 w-full bg-card">
      {/* Cột trái: phạm vi tài liệu, thư mục nghiệp vụ */}
      <aside className="hidden xl:flex w-60 shrink-0 border-r border-slate-200 bg-card flex-col min-h-0">
        <nav aria-label="Phạm vi tài liệu" className="flex-1 min-h-0 overflow-y-auto p-3 space-y-5">
          <div>
            <div className="px-2.5 pb-1.5 text-xs font-medium text-slate-500">Kho tài liệu</div>
            <div className="space-y-0.5">
              <NavRow
                active={activeSection === 'MY_DRIVE' && selectedCategory === 'ALL'}
                onClick={() => selectSection('MY_DRIVE')}
                icon={HardDrive}
                label={currentDept ? `Phòng ${currentDept}` : 'Kho phòng ban'}
                count={documents.length}
              />
              <NavRow
                active={activeSection === 'SHARED_WITH_ME'}
                onClick={() => selectSection('SHARED_WITH_ME')}
                icon={Users}
                label="Được chia sẻ đến phòng"
                count={sharedDocs.length}
              />
              {isManagerOrExec && (
                <NavRow
                  active={activeSection === 'APPROVALS'}
                  onClick={() => selectSection('APPROVALS')}
                  icon={UserCheck}
                  label="Yêu cầu chia sẻ"
                  count={pendingRequests > 0 ? pendingRequests : undefined}
                  countTone="warning"
                />
              )}
            </div>
          </div>

          <div>
            <div className="px-2.5 pb-1.5 text-xs font-medium text-slate-500">Phạm vi</div>
            <div className="space-y-0.5">
              <NavRow
                active={activeSection === 'CONFIDENTIAL'}
                onClick={() => selectSection('CONFIDENTIAL')}
                icon={Lock}
                label="Tài liệu mật (DLP)"
              />
              <NavRow
                active={activeSection === 'COMPANY'}
                onClick={() => selectSection('COMPANY')}
                icon={ShieldCheck}
                label="Toàn doanh nghiệp"
              />
            </div>
          </div>

          {categories.length > 0 && (
            <div>
              <div className="px-2.5 pb-1.5 text-xs font-medium text-slate-500">Thư mục nghiệp vụ</div>
              <div className="space-y-0.5">
                <NavRow
                  active={selectedCategory === 'ALL' && isDocSection}
                  onClick={() => setSelectedCategory('ALL')}
                  icon={Folder}
                  label="Tất cả thư mục"
                  count={documents.length}
                />
                {categories.map((cat) => (
                  <NavRow
                    key={cat}
                    active={selectedCategory === cat && isDocSection}
                    onClick={() => selectCategory(cat)}
                    icon={Folder}
                    label={cat}
                    count={documents.filter((d) => categoryOf(d) === cat).length}
                  />
                ))}
              </div>
            </div>
          )}
        </nav>
        <div className="px-4 py-3 border-t border-slate-200 shrink-0">
          <div className="text-xs font-medium text-slate-500">Kho tệp riêng</div>
          <div className="mt-1 font-mono text-micro text-slate-600 truncate">{currentDept.toLowerCase()}-documents</div>
        </div>
      </aside>

      {/* Khu vực giữa: thanh công cụ, số liệu, bảng */}
      <section className="flex-1 min-w-0 flex flex-col">
        {/* Phạm vi và thư mục khi màn hình hẹp (thay cho cột trái) */}
        <div className="xl:hidden px-4 pt-3 flex items-center gap-2 overflow-x-auto">
          <Segmented<DriveNavSection>
            value={activeSection}
            onChange={selectSection}
            options={[
              { value: 'MY_DRIVE', label: 'Kho phòng' },
              { value: 'SHARED_WITH_ME', label: 'Được chia sẻ' },
              ...(isManagerOrExec ? [{ value: 'APPROVALS' as DriveNavSection, label: 'Yêu cầu' }] : []),
              { value: 'CONFIDENTIAL', label: 'Tài liệu mật' },
              { value: 'COMPANY', label: 'Toàn doanh nghiệp' },
            ]}
          />
          {categories.length > 0 && (
            <select
              aria-label="Thư mục nghiệp vụ"
              value={selectedCategory}
              onChange={(e) => selectCategory(e.target.value)}
              className={`${SELECT} shrink-0`}
            >
              <option value="ALL">Mọi thư mục</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="h-12 px-4 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <nav aria-label="Vị trí hiện tại" className="flex items-center gap-1.5 text-data min-w-0">
            <span className="text-slate-500 truncate">Kho tài liệu</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
            <span className="font-semibold text-slate-900 truncate">{sectionTitle[activeSection]}</span>
            {selectedCategory !== 'ALL' && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                <span className="font-semibold text-slate-900 truncate">{selectedCategory}</span>
              </>
            )}
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tên, mã hoặc người tạo"
              wrapperClassName="w-44 xl:w-56"
            />
            <Button variant="primary" icon={Plus} onClick={() => setIsUploadOpen(true)}>
              Tải lên
            </Button>
          </div>
        </div>

        <div className={`grid grid-cols-2 ${isManagerOrExec ? 'md:grid-cols-5' : 'md:grid-cols-4'} border-b border-slate-200 bg-slate-50/60 shrink-0`}>
          {stats.map((s, i) => (
            <div key={s.label} className={`px-4 py-2.5 min-w-0 ${i > 0 ? 'border-l border-slate-200' : ''}`}>
              <div className="text-xs font-medium text-slate-500 truncate">{s.label}</div>
              <div className={`mt-0.5 text-lg font-semibold tabular-nums leading-tight ${s.tone}`}>{fmtNumber(s.value)}</div>
            </div>
          ))}
        </div>

        <div className="h-11 px-4 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-data font-semibold text-slate-900 truncate">{sectionTitle[activeSection]}</span>
            <span className="font-mono text-micro text-slate-500 whitespace-nowrap">{countText}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(activeSection === 'MY_DRIVE' || activeSection === 'CONFIDENTIAL' || activeSection === 'COMPANY') && (
              <>
                <select
                  aria-label="Lọc theo trạng thái"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className={`${SELECT} w-36`}
                >
                  <option value="ALL">Mọi trạng thái</option>
                  <option value="PUBLISHED">Đã ban hành</option>
                  <option value="DRAFT">Bản nháp</option>
                </select>
                <Segmented<TypeFilter>
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={[
                    { value: 'ALL', label: 'Mọi loại' },
                    { value: 'PDF', label: 'PDF' },
                    { value: 'EXCEL', label: 'Excel' },
                    { value: 'DOC', label: 'Word' },
                  ]}
                />
                <Segmented<ViewMode>
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: 'LIST', label: 'Bảng' },
                    { value: 'GRID', label: 'Lưới' },
                  ]}
                />
              </>
            )}
            <IconButton onClick={fetchData} disabled={isLoading} title="Làm mới danh sách" aria-label="Làm mới danh sách" size="sm">
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </IconButton>
            <IconButton
              onClick={() => setIsInspectorOpen((v) => !v)}
              active={isInspectorOpen}
              title={isInspectorOpen ? 'Ẩn bảng chi tiết tệp' : 'Xem chi tiết tệp'}
              aria-label={isInspectorOpen ? 'Ẩn bảng chi tiết tệp' : 'Xem chi tiết tệp'}
              size="sm"
              className="hidden 2xl:inline-flex"
            >
              <Info className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoading && documents.length === 0 && sharedDocs.length === 0 ? (
            <LoadingRows />
          ) : activeSection === 'SHARED_WITH_ME' ? (
            <>
              {unavailableNodes.length > 0 && (
                <div role="status" className="mx-4 mt-3 px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-data text-amber-800">
                  Không kết nối được tới máy chủ của phòng ban: {unavailableNodes.join(', ')}. Một số tài liệu chia sẻ từ các phòng này có thể tạm thời chưa hiển thị.
                </div>
              )}
              {renderShared()}
            </>
          ) : activeSection === 'APPROVALS' ? (
            renderApprovals()
          ) : filteredDocs.length === 0 ? (
            <EmptyState
              title={searchQuery ? `Không có tài liệu khớp "${searchQuery}"` : 'Chưa có tài liệu trong mục này'}
              hint={searchQuery ? 'Thử từ khóa khác hoặc bỏ bớt bộ lọc.' : 'Tải lên tài liệu mới bằng nút Tải lên ở trên.'}
            />
          ) : viewMode === 'LIST' ? (
            renderDocTable()
          ) : (
            renderDocGrid()
          )}
        </div>
      </section>

      {/* Cột phải: chi tiết tệp đang chọn */}
      {showInspector && activeSelectedDoc && (
        <aside className="hidden 2xl:flex w-72 shrink-0 border-l border-slate-200 bg-card flex-col min-h-0">
          <div className="h-11 px-4 border-b border-slate-200 flex items-center justify-between shrink-0">
            <span className="text-data font-semibold text-slate-900">Chi tiết tệp</span>
            <IconButton size="sm" ghost title="Ẩn bảng chi tiết" aria-label="Ẩn bảng chi tiết" onClick={() => setIsInspectorOpen(false)}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-md bg-slate-50 border border-slate-200 flex items-center justify-center shrink-0">
                {fileIcon(activeSelectedDoc.title, 'w-5 h-5')}
              </div>
              <div className="min-w-0">
                <div className="text-data font-semibold text-slate-900 break-words">{activeSelectedDoc.title}</div>
                <div className="mt-0.5 font-mono text-micro text-slate-500">
                  #DOC-{activeSelectedDoc.docId} · v{activeSelectedDoc.currentVersion}.0
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <DocStatusPill status={activeSelectedDoc.status} />
              <AccessPill level={activeSelectedDoc.accessLevel} />
            </div>

            <dl className="divide-y divide-slate-100 rounded-md border border-slate-200">
              <MetaRow label="Người tạo">{activeSelectedDoc.creator?.fullName || activeSelectedDoc.creator?.username || 'Hệ thống'}</MetaRow>
              <MetaRow label="Phiên bản">
                <span className="font-mono">v{activeSelectedDoc.currentVersion}.0</span>
              </MetaRow>
              <MetaRow label="Ngày tạo">
                <span className="font-mono">{fmtDate(activeSelectedDoc.createdAt)}</span>
              </MetaRow>
              <MetaRow label="Cập nhật">
                <span className="font-mono">{fmtDate(activeSelectedDoc.updatedAt || activeSelectedDoc.createdAt)}</span>
              </MetaRow>
              <MetaRow label="Lưu trữ">
                <span className="font-mono">MinIO · {currentDept.toLowerCase()}</span>
              </MetaRow>
            </dl>
          </div>

          <div className="p-4 border-t border-slate-200 bg-slate-50/60 space-y-2 shrink-0">
            <Button variant="primary" icon={Download} className="w-full" onClick={() => handleDownload(activeSelectedDoc.docId)}>
              Tải tệp về máy
            </Button>
            <div className={`grid gap-2 ${isManagerOrExec ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <Button icon={ExternalLink} onClick={() => setDrawerDocId(activeSelectedDoc.docId)}>
                Chi tiết đầy đủ
              </Button>
              {isManagerOrExec && (
                <Button icon={Share2} onClick={() => setShareDoc({ id: activeSelectedDoc.docId, title: activeSelectedDoc.title })}>
                  Chia sẻ
                </Button>
              )}
            </div>
          </div>
        </aside>
      )}

      {/* Cửa sổ phụ: giữ nguyên hành vi như trước */}
      {isUploadOpen && (
        <UploadModal
          isOpen={isUploadOpen}
          onClose={() => setIsUploadOpen(false)}
          onSuccess={() => {
            fetchData();
            setIsUploadOpen(false);
          }}
        />
      )}

      {shareDoc && (
        <ShareModal
          isOpen={!!shareDoc}
          onClose={() => setShareDoc(null)}
          docId={shareDoc.id}
          docTitle={shareDoc.title}
          onSuccess={() => {
            fetchData();
            setShareDoc(null);
          }}
        />
      )}

      {drawerDocId && (
        <DocumentDetailDrawer
          isOpen={!!drawerDocId}
          onClose={() => setDrawerDocId(null)}
          docId={drawerDocId}
          dept={currentDept}
          onDownload={handleDownload}
          onShare={(id, title) => setShareDoc({ id, title })}
          onRefresh={fetchData}
        />
      )}

      {selectedSharedDoc && (
        <SharedDocDetailDrawer isOpen={!!selectedSharedDoc} onClose={() => setSelectedSharedDoc(null)} sharedDoc={selectedSharedDoc} />
      )}

      {isRequestAccessOpen && (
        <RequestAccessModal
          isOpen={isRequestAccessOpen}
          onClose={() => setIsRequestAccessOpen(false)}
          onSuccess={() => {
            fetchData();
            setIsRequestAccessOpen(false);
          }}
        />
      )}
    </div>
  );
};
