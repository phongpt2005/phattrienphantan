import React, { useState } from 'react';
import { Download, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SharedDocumentItem } from '../types';
import { searchApi } from '../services/api';
import { useToast } from '../context/ToastContext';
import { Button, Drawer, Panel, Pill, Tabs } from './ui';
import type { TabItem } from './ui';

interface SharedDocDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  sharedDoc: SharedDocumentItem | null;
}

type DrawerTab = 'METADATA' | 'PREVIEW';

const tabItems: Array<TabItem<DrawerTab>> = [
  { value: 'METADATA', label: 'Thông tin cấp phép' },
  { value: 'PREVIEW', label: 'Xem trước trực tuyến' },
];

const calculateDaysRemaining = (expiresAtStr: string) => {
  const diffMs = new Date(expiresAtStr).getTime() - Date.now();
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Đã hết thời hạn hiệu lực';
  return `Còn lại ${days} ngày hiệu lực`;
};

/** Chi tiết tài liệu phòng khác chia sẻ cho phòng bạn: quyền, thời hạn, lý do và xem trước có đóng dấu DLP. */
export const SharedDocDetailDrawer: React.FC<SharedDocDetailDrawerProps> = ({ isOpen, onClose, sharedDoc }) => {
  const { user } = useAuth();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<DrawerTab>('METADATA');
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  if (!isOpen || !sharedDoc) return null;

  const isDownloadPermitted = sharedDoc.permission === 'DOWNLOAD';

  const handleDownloadClick = () => {
    if (!isDownloadPermitted) {
      toast.warning('Tài liệu này được cấp quyền CHỈ XEM ONLINE (DLP). Không được phép tải về máy.');
      return;
    }

    // Tải tệp THẬT từ node chủ sở hữu qua Search Gateway (kiểm tra quyền DOWNLOAD, node ghi audit)
    searchApi
      .downloadShared(sharedDoc.shared_by_dept, sharedDoc.source_doc_id as number)
      .then(() => {
        toast.success('Đã tải xuống tệp tài liệu được ủy quyền');
        setDownloadSuccess(true);
        setTimeout(() => setDownloadSuccess(false), 3000);
      })
      .catch((e) => toast.error(e.message, 'Không tải được tệp'));
  };

  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      width="lg"
      title={sharedDoc.title}
      subtitle={`Phòng ${sharedDoc.shared_by_dept} cung cấp · #DOC-${sharedDoc.source_doc_id}`}
      actions={
        <Pill tone={isDownloadPermitted ? 'success' : 'info'}>{isDownloadPermitted ? 'ĐƯỢC PHÉP TẢI VỀ' : 'CHỈ XEM - DLP'}</Pill>
      }
    >
      <div className="px-4 pt-2">
        <Tabs<DrawerTab> value={activeTab} onChange={setActiveTab} items={tabItems} />
      </div>

      <div className="p-4 space-y-4">
        {activeTab === 'METADATA' && (
          <>
            <div
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-micro leading-relaxed ${
                isDownloadPermitted ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-blue-200 bg-blue-50 text-blue-900'
              }`}
            >
              {isDownloadPermitted ? (
                <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-px" />
              ) : (
                <ShieldAlert className="w-4 h-4 text-blue-700 shrink-0 mt-px" />
              )}
              <span>
                <strong>Chính sách DLP doanh nghiệp: </strong>
                {isDownloadPermitted
                  ? 'Trưởng phòng sở hữu đã cấp quyền tải về bản sao phục vụ phối hợp nghiệp vụ. Mọi hành vi lưu trữ ra ngoài phải tuân thủ bảo mật nội bộ.'
                  : 'Tài liệu này được cấp quyền chỉ xem trực tuyến. Hệ thống không cho phép tải về máy tính cá nhân.'}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-px rounded-lg border border-slate-200 bg-slate-200 overflow-hidden">
              {[
                { k: 'Đơn vị cung cấp', v: `Phòng ${sharedDoc.shared_by_dept}`, mono: true },
                { k: 'Thời hạn hiệu lực', v: calculateDaysRemaining(sharedDoc.expires_at), mono: false, tone: 'text-amber-700' },
                { k: 'Ngày cấp quyền', v: new Date(sharedDoc.created_at).toLocaleDateString('vi-VN'), mono: true },
                { k: 'Chủ sở hữu bản gốc', v: sharedDoc.owner_name || `Cán bộ Phòng ${sharedDoc.shared_by_dept}`, mono: false },
              ].map((item) => (
                <div key={item.k} className="bg-white px-3 py-2.5 min-w-0">
                  <dt className="text-micro font-semibold uppercase tracking-wider text-slate-500">{item.k}</dt>
                  <dd className={`mt-0.5 text-data font-medium truncate ${item.mono ? 'font-mono' : ''} ${item.tone ?? 'text-slate-900'}`}>{item.v}</dd>
                </div>
              ))}
            </dl>

            <Panel title="Lý do chia sẻ đã phê chuẩn">
              <p className="p-3.5 text-data text-slate-700 leading-relaxed">
                {sharedDoc.reason || 'Chia sẻ phục vụ phối hợp nghiệp vụ giữa các phòng ban theo chỉ đạo.'}
              </p>
            </Panel>

            <Panel title="Trích yếu nội dung tài liệu">
              <p className="p-3.5 text-data text-slate-700 leading-relaxed whitespace-pre-wrap">
                {sharedDoc.description || 'Không có mô tả chi tiết kèm theo.'}
              </p>
            </Panel>

            {isDownloadPermitted ? (
              <Button variant="primary" icon={Download} className="w-full h-9" onClick={handleDownloadClick}>
                {downloadSuccess ? 'Đã tải tệp về máy' : 'Tải xuống bản gốc được ủy quyền'}
              </Button>
            ) : (
              <div className="flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-slate-100 px-3 py-2.5 text-data text-slate-600">
                <Lock className="w-4 h-4 text-slate-500" />
                <span>Chỉ xem trực tuyến. Chức năng tải về bị khóa bởi chính sách DLP.</span>
              </div>
            )}
          </>
        )}

        {activeTab === 'PREVIEW' && (
          <>
            <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-micro text-blue-800">
              <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-px" />
              <span>Trình xem được bảo vệ DLP ngay trong phiên làm việc của bạn. Mọi lần truy xuất đều được ghi nhật ký.</span>
            </div>

            <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-white p-5 min-h-[340px] select-none">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex flex-col justify-around -rotate-[25deg] opacity-[0.06] font-mono text-data font-bold text-slate-900 whitespace-nowrap"
              >
                <span className="text-center">
                  {user?.fullName} · PHÒNG {sharedDoc.shared_with_dept} · BẢO MẬT
                </span>
                <span className="text-center">
                  NGUỒN: PHÒNG {sharedDoc.shared_by_dept} · {new Date().toLocaleDateString('vi-VN')}
                </span>
                <span className="text-center">MÃ HỒ SƠ #{sharedDoc.source_doc_id} · CHỈ XEM TRỰC TUYẾN</span>
              </div>

              <div className="relative space-y-4">
                <div className="border-b border-slate-200 pb-3">
                  <h3 className="text-base font-semibold text-slate-900">{sharedDoc.title}</h3>
                  <div className="mt-1 font-mono text-micro text-slate-500">
                    Phòng nguồn: {sharedDoc.shared_by_dept} · Quyền hạn: {sharedDoc.permission === 'DOWNLOAD' ? 'được tải về' : 'chỉ xem'}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-micro font-semibold uppercase tracking-wider text-slate-500">Nội dung trích lược</div>
                  <p className="text-data text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {sharedDoc.description || 'Nội dung hồ sơ liên phòng ban đã được xác thực toàn vẹn.'}
                  </p>
                </div>

                <dl className="space-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-micro text-slate-600">
                  <div>Tên tệp gốc: {sharedDoc.file_name || 'document_archive.bin'}</div>
                  <div>Mã chỉ mục phân tán: #DOC-{sharedDoc.source_doc_id}</div>
                  <div>Hiệu lực đến: {new Date(sharedDoc.expires_at).toLocaleString('vi-VN')}</div>
                </dl>
              </div>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
};
