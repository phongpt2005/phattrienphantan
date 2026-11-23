import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { documentApi, searchApi } from '../services/api';
import { DocumentItem, SharedDocumentItem, AccessRequestItem } from '../types';
import { useToast } from '../context/ToastContext';
import {
  Folder,
  FolderOpen,
  FileText,
  FileSpreadsheet,
  FileCheck,
  FileCode,
  File,
  Plus,
  RefreshCw,
  Search,
  LayoutGrid,
  List,
  Info,
  Download,
  Share2,
  CheckCircle2,
  Clock,
  ShieldCheck,
  HardDrive,
  Users,
  ChevronRight,
  Lock,
  Copy,
  Check,
  ExternalLink,
  X,
  UserCheck,
} from 'lucide-react';
import { UploadModal } from './UploadModal';
import { ShareModal } from './ShareModal';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { SharedDocDetailDrawer } from './SharedDocDetailDrawer';
import { RequestAccessModal } from './RequestAccessModal';

type DriveNavSection = 'MY_DRIVE' | 'SHARED_WITH_ME' | 'APPROVALS' | 'CONFIDENTIAL' | 'COMPANY';

export const WorkspaceTab: React.FC = () => {
  const { user } = useAuth();
  const toast = useToast();
  const currentDept = user?.departmentCode ?? '';
  const isManagerOrExec = user?.role === 'MANAGER' || !!user?.isExecutive;

  // Navigation Drive State
  const [activeSection, setActiveSection] = useState<DriveNavSection>('MY_DRIVE');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'LIST' | 'GRID'>('LIST');
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);

  // Data States
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [sharedDocs, setSharedDocs] = useState<SharedDocumentItem[]>([]);
  // Node phòng ban không trả lời khi gom "được chia sẻ với tôi" (kết quả chỉ một phần)
  const [unavailableNodes, setUnavailableNodes] = useState<string[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'PDF' | 'EXCEL' | 'DOC' | 'OTHER'>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'DRAFT' | 'PUBLISHED'>('ALL');

  // Selected File for Inspector
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [selectedSharedDoc, setSelectedSharedDoc] = useState<SharedDocumentItem | null>(null);
  const [drawerDocId, setDrawerDocId] = useState<number | null>(null);

  // Modals
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isRequestAccessOpen, setIsRequestAccessOpen] = useState(false);
  const [shareDoc, setShareDoc] = useState<{ id: number; title: string } | null>(null);

  // Copy SHA state
  const [copiedSha, setCopiedSha] = useState(false);

  // Fetch Data
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

  // Handle Download
  const handleDownload = (docId: number) => {
    documentApi.download(currentDept, docId).catch((e) => toast.error(e.message, 'Lỗi tải tệp'));
    toast.info(`Đang tải tệp hồ sơ #DOC-${docId}`);
  };

  // Categories list
  const categories = useMemo(() => {
    const set = new Set<string>();
    documents.forEach((d) => {
      const c = d.category?.name || d.category?.categoryName;
      if (c) set.add(c);
    });
    return Array.from(set);
  }, [documents]);

  // Filter documents based on active section and search
  const filteredDocs = useMemo(() => {
    return documents.filter((d) => {
      // 1. Section filter
      if (activeSection === 'CONFIDENTIAL' && d.accessLevel !== 'CONFIDENTIAL') return false;
      if (activeSection === 'COMPANY' && d.accessLevel !== 'COMPANY') return false;

      // 2. Category filter
      if (selectedCategory !== 'ALL') {
        const c = d.category?.name || d.category?.categoryName;
        if (c !== selectedCategory) return false;
      }

      // 3. Status filter
      if (statusFilter !== 'ALL' && d.status !== statusFilter) return false;

      // 4. File Type filter
      if (typeFilter !== 'ALL') {
        const lower = d.title.toLowerCase();
        if (typeFilter === 'PDF' && !lower.endsWith('.pdf')) return false;
        if (typeFilter === 'EXCEL' && !lower.match(/\.(xlsx|xls|csv)$/)) return false;
        if (typeFilter === 'DOC' && !lower.match(/\.(docx|doc)$/)) return false;
      }

      // 5. Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = d.title.toLowerCase().includes(q);
        const matchId = `doc-${d.docId}`.includes(q);
        const matchCat = (d.category?.name || '').toLowerCase().includes(q);
        const matchCreator = (d.creator?.fullName || d.creator?.username || '').toLowerCase().includes(q);
        if (!matchTitle && !matchId && !matchCat && !matchCreator) return false;
      }

      return true;
    });
  }, [documents, activeSection, selectedCategory, statusFilter, typeFilter, searchQuery]);

  // Selected Doc Item
  const activeSelectedDoc = useMemo(() => {
    if (!selectedDocId) return filteredDocs[0] || null;
    return documents.find((d) => d.docId === selectedDocId) || null;
  }, [selectedDocId, documents, filteredDocs]);

  // Helper file icon with Google Drive colors
  const getFileIcon = (title: string, className = 'w-4 h-4') => {
    const lower = title.toLowerCase();
    if (lower.endsWith('.pdf')) return <FileText className={`${className} text-red-500 fill-red-50/50`} />;
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv'))
      return <FileSpreadsheet className={`${className} text-emerald-600 fill-emerald-50/50`} />;
    if (lower.endsWith('.docx') || lower.endsWith('.doc'))
      return <FileCheck className={`${className} text-blue-600 fill-blue-50/50`} />;
    if (lower.endsWith('.json') || lower.endsWith('.xml') || lower.endsWith('.sql'))
      return <FileCode className={`${className} text-amber-500 fill-amber-50/50`} />;
    return <File className={`${className} text-slate-500 fill-slate-50/50`} />;
  };

  const handleCopySha = (sha: string) => {
    navigator.clipboard.writeText(sha);
    setCopiedSha(true);
    toast.success('Đã sao chép mã băm SHA-256');
    setTimeout(() => setCopiedSha(false), 2000);
  };

  return (
    <div className="flex flex-1 h-full w-full bg-white overflow-hidden select-none">
      {/* ========================================================================= */}
      {/* 1. LEFT PANE: GOOGLE DRIVE STYLE FOLDER TREE & NAVIGATION */}
      {/* ========================================================================= */}
      <div className="w-64 border-r border-slate-200/80 bg-slate-50/50 flex flex-col justify-between shrink-0">
        <div className="p-3.5 space-y-4 overflow-y-auto">
          {/* New Document Button (Google Drive '+ Mới' Pill) */}
          <div className="pt-1">
            <button
              onClick={() => setIsUploadOpen(true)}
              className="w-full flex items-center justify-center gap-2 h-9 px-3 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded border border-slate-900 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Tải lên văn bản mới</span>
            </button>
          </div>

          {/* Quick Drive Navigation Sections */}
          <div className="space-y-0.5 text-xs font-medium">
            <button
              onClick={() => {
                setActiveSection('MY_DRIVE');
                setSelectedCategory('ALL');
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded transition-colors ${
                activeSection === 'MY_DRIVE' && selectedCategory === 'ALL'
                  ? 'bg-blue-100/70 text-blue-900 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100/80'
              }`}
            >
              <div className="flex items-center gap-3 truncate">
                <HardDrive className="w-4 h-4 text-blue-600 shrink-0" />
                <span className="truncate">Kho Của Tôi ({currentDept})</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-200/60 text-slate-600">
                {documents.length}
              </span>
            </button>

            <button
              onClick={() => {
                setActiveSection('SHARED_WITH_ME');
                setSelectedCategory('ALL');
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded transition-colors ${
                activeSection === 'SHARED_WITH_ME'
                  ? 'bg-blue-100/70 text-blue-900 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100/80'
              }`}
            >
              <div className="flex items-center gap-3 truncate">
                <Users className="w-4 h-4 text-indigo-600 shrink-0" />
                <span className="truncate">Được Chia Sẻ Với Tôi</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">
                {sharedDocs.length}
              </span>
            </button>

            {isManagerOrExec && (
              <button
                onClick={() => {
                  setActiveSection('APPROVALS');
                  setSelectedCategory('ALL');
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded transition-colors ${
                  activeSection === 'APPROVALS'
                    ? 'bg-blue-100/70 text-blue-900 font-semibold'
                    : 'text-slate-700 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-3 truncate">
                  <UserCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="truncate">Yêu Cầu Chia Sẻ</span>
                </div>
                {accessRequests.filter((r) => r.status === 'PENDING').length > 0 && (
                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-500 text-white">
                    {accessRequests.filter((r) => r.status === 'PENDING').length}
                  </span>
                )}
              </button>
            )}

            <button
              onClick={() => {
                setActiveSection('CONFIDENTIAL');
                setSelectedCategory('ALL');
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded transition-colors ${
                activeSection === 'CONFIDENTIAL'
                  ? 'bg-blue-100/70 text-blue-900 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100/80'
              }`}
            >
              <div className="flex items-center gap-3 truncate">
                <Lock className="w-4 h-4 text-red-500 shrink-0" />
                <span className="truncate">Tài Liệu Mật (DLP)</span>
              </div>
            </button>

            <button
              onClick={() => {
                setActiveSection('COMPANY');
                setSelectedCategory('ALL');
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded transition-colors ${
                activeSection === 'COMPANY'
                  ? 'bg-blue-100/70 text-blue-900 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100/80'
              }`}
            >
              <div className="flex items-center gap-3 truncate">
                <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="truncate">Toàn Doanh Nghiệp</span>
              </div>
            </button>
          </div>

          {/* Categories / Folders Header */}
          <div className="pt-2">
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Thư Mục Nghiệp Vụ
            </div>
            <div className="space-y-0.5 mt-1 text-xs">
              <button
                onClick={() => setSelectedCategory('ALL')}
                className={`w-full flex items-center justify-between px-3 py-1.5 rounded transition-colors ${
                  selectedCategory === 'ALL' && activeSection === 'MY_DRIVE'
                    ? 'text-blue-700 font-semibold bg-white shadow-2xs'
                    : 'text-slate-600 hover:bg-slate-100/80'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Folder className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="truncate">Tất cả thư mục</span>
                </div>
              </button>

              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => {
                    setActiveSection('MY_DRIVE');
                    setSelectedCategory(cat);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-1.5 rounded transition-colors ${
                    selectedCategory === cat
                      ? 'text-blue-700 font-semibold bg-white shadow-2xs'
                      : 'text-slate-600 hover:bg-slate-100/80'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Folder className="w-4 h-4 text-amber-500 fill-amber-100/80 shrink-0" />
                    <span className="truncate">{cat}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Kho tệp riêng của phòng ban (không hiển thị dung lượng giả) */}
        <div className="px-4 py-3 border-t border-slate-200 bg-white">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            <HardDrive className="w-3.5 h-3.5" /> Kho tệp riêng
          </div>
          <div className="text-[11px] text-slate-600 font-mono mt-1">Bucket: {currentDept.toLowerCase()}-documents</div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. MAIN CENTER CANVAS: GOOGLE DRIVE / GITHUB FILE EXPLORER */}
      {/* ========================================================================= */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Top Explorer Action Bar */}
        <div className="h-14 border-b border-slate-200/80 px-5 flex items-center justify-between gap-3 shrink-0 bg-white">
          {/* Breadcrumb Path */}
          <div className="flex items-center gap-2 text-xs text-slate-600 truncate">
            <span className="font-medium text-slate-700">Kho Tài Liệu</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
            <span className="font-semibold text-blue-700">
              {activeSection === 'MY_DRIVE'
                ? `Phòng ${currentDept}`
                : activeSection === 'SHARED_WITH_ME'
                ? 'Được Chia Sẻ'
                : activeSection === 'APPROVALS'
                ? 'Yêu Cầu Chia Sẻ'
                : activeSection === 'CONFIDENTIAL'
                ? 'Tài Liệu Mật'
                : 'Toàn Doanh Nghiệp'}
            </span>
            {selectedCategory !== 'ALL' && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <span className="text-slate-900 font-bold">{selectedCategory}</span>
              </>
            )}
          </div>

          {/* Right Toolbar Controls */}
          <div className="flex items-center gap-2.5 shrink-0">
            {/* Quick in-folder search with Google Drive rounded pill */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm kiếm trong thư mục..."
                className="w-48 sm:w-60 pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 bg-slate-100/70 hover:bg-slate-100 border border-transparent focus:border-blue-400 focus:bg-white rounded transition-all focus:outline-hidden focus:ring-2 focus:ring-blue-500/10"
              />
            </div>

            {/* Filter Pills */}
            <div className="hidden md:flex items-center gap-1 text-xs">
              {(['ALL', 'PDF', 'EXCEL'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    typeFilter === t
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'text-slate-600 hover:bg-slate-100 border border-slate-200/80 bg-white'
                  }`}
                >
                  {t === 'ALL' ? 'Tất cả' : t}
                </button>
              ))}
            </div>

            {/* View Mode Toggle (List vs Grid) */}
            <div className="flex items-center border border-slate-200/80 rounded p-0.5 bg-slate-50 text-slate-500">
              <button
                onClick={() => setViewMode('LIST')}
                title="Chế độ Danh sách (List View)"
                className={`p-1.5 rounded transition-all ${
                  viewMode === 'LIST' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'hover:text-slate-900'
                }`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('GRID')}
                title="Chế độ Lưới thẻ (Grid View)"
                className={`p-1.5 rounded transition-all ${
                  viewMode === 'GRID' ? 'bg-white text-slate-900 shadow-2xs font-bold' : 'hover:text-slate-900'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Reload button */}
            <button
              onClick={fetchData}
              disabled={isLoading}
              title="Làm mới danh sách"
              className="p-1.5 rounded border border-slate-200/80 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            </button>

            {/* Toggle Inspector Pane Button */}
            <button
              onClick={() => setIsInspectorOpen(!isInspectorOpen)}
              title={isInspectorOpen ? 'Ẩn bảng chi tiết tệp' : 'Xem chi tiết tệp'}
              className={`p-1.5 rounded border transition-colors ${
                isInspectorOpen
                  ? 'bg-blue-50 border-blue-200 text-blue-700 font-bold'
                  : 'border-slate-200/80 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content Explorer Scrollable Area */}
        <div className="flex-1 overflow-y-auto">
          {/* Section: Folders (Shown if on root of My Drive) */}
          {activeSection === 'MY_DRIVE' && selectedCategory === 'ALL' && categories.length > 0 && !searchQuery && (
            <div className="p-5 border-b border-slate-100">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                Thư Mục Nghiệp Vụ
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3.5">
                {categories.map((cat) => {
                  const count = documents.filter((d) => (d.category?.name || d.category?.categoryName) === cat).length;
                  return (
                    <div
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      className="flex items-center gap-3 px-3.5 py-3 rounded bg-slate-50/70 hover:bg-slate-100/80 border border-slate-200/70 hover:border-slate-300 transition-all cursor-pointer shadow-2xs"
                    >
                      <Folder className="w-5 h-5 text-amber-500 fill-amber-100/80 shrink-0" />
                      <div className="truncate min-w-0">
                        <div className="font-semibold text-xs text-slate-800 truncate">{cat}</div>
                        <div className="text-[10px] text-slate-400 font-mono">{count} tệp tin</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section: Files List / Grid View */}
          {activeSection === 'SHARED_WITH_ME' ? (
            /* SHARED WITH ME SECTION */
            <div className="p-5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                Văn Bản Được Chia Sẻ Từ Phòng Khác ({sharedDocs.length})
              </div>
              {unavailableNodes.length > 0 && (
                <div role="status" className="mb-3 px-3.5 py-2 rounded border border-amber-200 bg-amber-50 text-xs text-amber-800">
                  ⚠️ Lưu ý: Không thể kết nối đến Node máy chủ của phòng ban: [{unavailableNodes.join(', ')}]. Một số tài liệu chia sẻ từ đơn vị này có thể tạm thời chưa hiển thị.
                </div>
              )}
              {sharedDocs.length === 0 ? (
                <div className="py-24 text-center text-slate-400 text-xs">
                  {unavailableNodes.length > 0
                    ? 'Chưa lấy được văn bản chia sẻ nào: một số phòng ban đang không phản hồi.'
                    : 'Hiện chưa có văn bản nào được chia sẻ đến phòng ban của bạn.'}
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200/80 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      <th className="py-2.5 px-4">Tên tài liệu</th>
                      <th className="py-2.5 px-4">Phòng ban cấp</th>
                      <th className="py-2.5 px-4">Quyền hạn</th>
                      <th className="py-2.5 px-4">Thời hạn</th>
                      <th className="py-2.5 px-4 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {sharedDocs.map((item) => (
                      <tr
                        key={item.share_id}
                        onClick={() => setSelectedSharedDoc(item)}
                        className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 font-sans font-medium text-slate-800 flex items-center gap-2.5">
                          {getFileIcon(item.title || '')}
                          <span className="truncate">{item.title || `Văn bản #${item.source_doc_id}`}</span>
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          <span className="px-2 py-0.5 rounded bg-slate-100 font-bold border border-slate-200/80 text-[11px]">
                            Phòng {item.shared_by_dept}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {item.permission === 'DOWNLOAD' ? (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200/80">
                              ĐƯỢC TẢI VỀ
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200/80">
                              CHỈ XEM (DLP)
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-500 text-[11px]">
                          {item.expires_at ? new Date(item.expires_at).toLocaleDateString('vi-VN') : 'Vĩnh viễn'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSharedDoc(item);
                            }}
                            className="px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors"
                          >
                            Xem chi tiết
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : activeSection === 'APPROVALS' ? (
            /* APPROVALS SECTION */
            <div className="p-5 space-y-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Yêu Cầu Cấp Quyền Truy Cập Văn Bản Đang Chờ Duyệt ({accessRequests.length})
              </div>
              {accessRequests.length === 0 ? (
                <div className="py-24 text-center text-slate-400 text-xs">
                  Không có yêu cầu cấp quyền nào đang chờ xử lý.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {accessRequests.map((req) => (
                    <div
                      key={req.request_id}
                      className="p-4 rounded border border-slate-200/80 hover:border-slate-300 bg-white shadow-2xs flex items-center justify-between gap-4"
                    >
                      <div className="space-y-1 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">
                            Văn bản #{req.central_doc_id}
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200/80 font-bold">
                            {req.status}
                          </span>
                        </div>
                        <div className="text-slate-500 text-[11px]">
                          Phòng xin quyền: <strong className="text-slate-700">{req.requester_dept}</strong> ({req.requester_username}) - Lý do: {req.reason}
                        </div>
                      </div>

                      {req.status === 'PENDING' && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              await searchApi.approveAccessRequest(req.request_id, 'VIEW');
                              toast.success('Đã cấp quyền XEM cho văn bản');
                              fetchData();
                            }}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold transition-colors shadow-2xs"
                          >
                            Cấp Quyền Xem
                          </button>
                          <button
                            onClick={async () => {
                              await searchApi.approveAccessRequest(req.request_id, 'DOWNLOAD');
                              toast.success('Đã cấp quyền TẢI VỀ cho văn bản');
                              fetchData();
                            }}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold transition-colors shadow-2xs"
                          >
                            Cấp Quyền Tải
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* MY DRIVE REGULAR FILES */
            <div className="p-5">
              <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                <span>Tất Cả Tệp ({filteredDocs.length})</span>
                <span className="font-mono text-[10px] text-slate-400">Nhấp để xem chi tiết bên phải</span>
              </div>

              {filteredDocs.length === 0 ? (
                <div className="py-24 text-center text-slate-400 text-xs">
                  {searchQuery
                    ? `Không tìm thấy tài liệu phù hợp với "${searchQuery}".`
                    : 'Thư mục hiện tại chưa có tệp tin nào.'}
                </div>
              ) : viewMode === 'LIST' ? (
                /* GOOGLE DRIVE CLEAN LIST VIEW */
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200/80 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      <th className="py-2.5 px-4">Tên tệp tin</th>
                      <th className="py-2.5 px-4 hidden sm:table-cell">Chủ sở hữu</th>
                      <th className="py-2.5 px-4 hidden md:table-cell">Sửa đổi</th>
                      <th className="py-2.5 px-4">Trạng thái</th>
                      <th className="py-2.5 px-4 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredDocs.map((doc) => {
                      const isSelected = selectedDocId === doc.docId;
                      return (
                        <tr
                          key={doc.docId}
                          onClick={() => setSelectedDocId(doc.docId)}
                          onDoubleClick={() => setDrawerDocId(doc.docId)}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-blue-50/80 text-blue-900 border-l-3 border-l-blue-600'
                              : 'hover:bg-slate-50/80'
                          }`}
                        >
                          {/* File Name & Icon */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3 min-w-0">
                              {getFileIcon(doc.title, 'w-4 h-4 shrink-0')}
                              <div className="truncate">
                                <span className="font-medium text-slate-900 block truncate">
                                  {doc.title}
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono block">
                                  #DOC-{doc.docId} - v{doc.currentVersion}.0
                                </span>
                              </div>
                            </div>
                          </td>

                          {/* Owner */}
                          <td className="py-3 px-4 hidden sm:table-cell text-slate-600">
                            <div className="flex items-center gap-2 truncate">
                              <div className="w-5 h-5 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                                {(doc.creator?.username || 'U').slice(0, 1).toUpperCase()}
                              </div>
                              <span className="truncate">{doc.creator?.fullName || doc.creator?.username || 'Hệ thống'}</span>
                            </div>
                          </td>

                          {/* Last Modified */}
                          <td className="py-3 px-4 hidden md:table-cell text-slate-500 font-mono text-[11px]">
                            {new Date(doc.updatedAt || doc.createdAt).toLocaleDateString('vi-VN')}
                          </td>

                          {/* Status Badge */}
                          <td className="py-3 px-4">
                            {doc.status === 'PUBLISHED' ? (
                              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200/80">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ĐÃ BAN HÀNH
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200/80">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span> BẢN NHÁP
                              </span>
                            )}
                          </td>

                          {/* Quick Actions */}
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleDownload(doc.docId)}
                                title="Tải xuống tệp"
                                className="p-1.5 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              {isManagerOrExec && (
                                <button
                                  onClick={() => setShareDoc({ id: doc.docId, title: doc.title })}
                                  title="Chia sẻ liên phòng"
                                  className="p-1.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-colors"
                                >
                                  <Share2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => setDrawerDocId(doc.docId)}
                                title="Mở chi tiết đầy đủ"
                                className="p-1.5 rounded text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                /* GOOGLE DRIVE CLEAN GRID VIEW */
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {filteredDocs.map((doc) => {
                    const isSelected = selectedDocId === doc.docId;
                    return (
                      <div
                        key={doc.docId}
                        onClick={() => setSelectedDocId(doc.docId)}
                        onDoubleClick={() => setDrawerDocId(doc.docId)}
                        className={`p-3.5 rounded border transition-all cursor-pointer flex flex-col justify-between card-3d-hover ${
                          isSelected
                            ? 'bg-blue-50/70 border-blue-400 shadow-sm'
                            : 'bg-white border-slate-200/80 hover:border-slate-300 hover:shadow-2xs'
                        }`}
                      >
                        <div>
                          {/* File Preview Header Box with Realistic Paper Aspect */}
                          <div className="h-28 bg-slate-50 border border-slate-100 rounded flex flex-col items-center justify-center p-3 mb-3 relative overflow-hidden">
                            {getFileIcon(doc.title, 'w-10 h-10')}
                            <span className="text-[10px] text-slate-400 font-mono mt-1.5 font-semibold">
                              {doc.title.split('.').pop()?.toUpperCase() || 'FILE'}
                            </span>
                            {/* Watermark subtle effect */}
                            <div className="absolute inset-0 opacity-5 pointer-events-none flex items-center justify-center text-[10px] font-mono rotate-[-20deg]">
                              CONFIDENTIAL
                            </div>
                          </div>

                          <h3 className="font-medium text-xs text-slate-900 truncate" title={doc.title}>
                            {doc.title}
                          </h3>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                            #DOC-{doc.docId} - v{doc.currentVersion}.0
                          </div>
                        </div>

                        <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
                          <span>{new Date(doc.createdAt).toLocaleDateString('vi-VN')}</span>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => handleDownload(doc.docId)}
                              className="p-1 hover:text-slate-800"
                              title="Tải về"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDrawerDocId(doc.docId)}
                              className="p-1 hover:text-blue-700"
                              title="Chi tiết"
                            >
                              <Info className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. RIGHT INSPECTOR PANEL: GOOGLE DRIVE FILE DETAILS & AUDIT */}
      {/* ========================================================================= */}
      {isInspectorOpen && activeSelectedDoc && (
        <div className="w-76 border-l border-slate-200/80 bg-white flex flex-col justify-between shrink-0 overflow-y-auto animate-slide-left">
          <div className="p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <span className="text-xs font-bold text-slate-900">Chi Tiết Tệp Tin</span>
              <button
                onClick={() => setIsInspectorOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Thumbnail Preview Area with Paper Mockup */}
            <div className="p-5 bg-slate-50/60 rounded border border-slate-100 text-center space-y-2 relative overflow-hidden">
              <div className="w-14 h-14 rounded bg-white border border-slate-200/80 shadow-2xs flex items-center justify-center mx-auto">
                {getFileIcon(activeSelectedDoc.title, 'w-7 h-7')}
              </div>
              <h4 className="font-semibold text-xs text-slate-900 truncate" title={activeSelectedDoc.title}>
                {activeSelectedDoc.title}
              </h4>
              <div className="text-[10px] text-slate-400 font-mono">
                Mã: #DOC-{activeSelectedDoc.docId} - Bản: v{activeSelectedDoc.currentVersion}.0
              </div>
            </div>

            {/* Metadata Properties List (Google Drive Style) */}
            <div className="space-y-2.5 text-xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Thuộc Tính Tài Liệu
              </div>

              <div className="p-3 bg-slate-50/50 rounded border border-slate-100 space-y-2.5">
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Trạng thái:</span>
                  <span className="font-medium text-slate-800">
                    {activeSelectedDoc.status === 'PUBLISHED' ? 'Đã Ban Hành' : 'Bản Thảo (Chưa duyệt)'}
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Phân quyền:</span>
                  <span className="font-medium text-slate-800">
                    {activeSelectedDoc.accessLevel === 'COMPANY'
                      ? 'Toàn Công Ty'
                      : activeSelectedDoc.accessLevel === 'CONFIDENTIAL'
                      ? 'Bảo Mật Cao'
                      : 'Nội Bộ Phòng Ban'}
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Người tạo:</span>
                  <span className="font-medium text-slate-800">
                    {activeSelectedDoc.creator?.fullName || activeSelectedDoc.creator?.username || 'Hệ thống'}
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Ngày tạo:</span>
                  <span className="font-mono text-slate-800 text-[11px]">
                    {new Date(activeSelectedDoc.createdAt).toLocaleDateString('vi-VN')}
                  </span>
                </div>

                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Lưu trữ:</span>
                  <span className="font-mono text-slate-800 text-[11px]">MinIO S3 ({currentDept.toLowerCase()})</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Action Footer in Inspector */}
          <div className="p-4 border-t border-slate-100 bg-white space-y-2">
            <button
              onClick={() => handleDownload(activeSelectedDoc.docId)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold transition-all shadow-xs"
            >
              <Download className="w-3.5 h-3.5" /> Tải Tệp Về Máy
            </button>
            <button
              onClick={() => setDrawerDocId(activeSelectedDoc.docId)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-medium transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Xem Toàn Diện (Drawer)
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. MODALS & SLIDE-OVER DRAWERS */}
      {/* ========================================================================= */}
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
        <SharedDocDetailDrawer
          isOpen={!!selectedSharedDoc}
          onClose={() => setSelectedSharedDoc(null)}
          sharedDoc={selectedSharedDoc}
        />
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
