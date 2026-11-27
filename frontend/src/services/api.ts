import axios from 'axios';
import {
  DocumentItem,
  DocumentDetail,
  SearchResultItem,
  ExecutiveStats,
  AuditStreamItem,
  SharedDocumentItem,
  SharesWithDeptResponse,
  AccessRequestItem,
  SearchResponse,
  SystemHealth,
  ClusterMap,
} from '../types';

const API_BASE = ''; // Relative via Gateway port 8000

/** Định tuyến động theo mã phòng ban: /api/dept/<code>/... (không còn hardcode HR/ACC). */
export const deptBase = (dept: string) => `/api/dept/${dept.toLowerCase()}`;

export const apiClient = axios.create({
  baseURL: API_BASE,
});

// Tự động đính kèm Token cho MỌI request
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('dms_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const setAuthToken = (token: string | null) => {
  if (token) {
    localStorage.setItem('dms_token', token);
    apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    localStorage.removeItem('dms_token');
    delete apiClient.defaults.headers.common['Authorization'];
  }
};

/**
 * Tải file CÓ gửi token (window.open không mang header Authorization nên trước đây luôn 401).
 * Lỗi từ server (JSON) được đọc từ blob để hiển thị thông báo đúng.
 */
export const downloadFile = async (url: string, fallbackName = 'tai-lieu') => {
  try {
    const res = await apiClient.get(url, { responseType: 'blob' });
    const disposition: string = res.headers['content-disposition'] || '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]) : fallbackName;
    const blobUrl = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  } catch (err: any) {
    let message = err.message || 'Không tải được tệp';
    const data = err.response?.data;
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text());
        message = Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message || message;
      } catch {
        /* giữ message mặc định */
      }
    }
    throw new Error(message);
  }
};

// Danh sách phòng ban động từ Registry
export interface RegistryDepartment {
  code: string;
  name: string;
  available: boolean;
}
export const registryApi = {
  listPublic: async (): Promise<RegistryDepartment[]> => {
    const res = await apiClient.get('/api/registry/departments/public');
    return res.data;
  },
};

// API xác thực
export const authApi = {
  login: async (dept: string, credentials: { username: string; password: string }) => {
    const res = await apiClient.post(`${deptBase(dept)}/auth/login`, credentials);
    return res.data;
  },
};

// API Kho tài liệu phòng ban (Workspace)
export const documentApi = {
  getDocuments: async (
    dept: string,
    page = 1,
    limit = 50,
    categoryId?: number,
    status?: string,
  ): Promise<{ total: number; data: DocumentItem[]; totalPages?: number }> => {
    const endpoint = `${deptBase(dept)}/documents`;
    const params: Record<string, any> = { page, limit };
    if (categoryId) params.categoryId = categoryId;
    if (status && status !== 'ALL') params.status = status;
    const res = await apiClient.get(endpoint, { params });
    return res.data;
  },

  getDocumentDetail: async (dept: string, docId: number): Promise<DocumentDetail> => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.get(`${endpoint}/${docId}`);
    return res.data;
  },

  /** Danh mục nghiệp vụ của phòng (bảng category của node), để chọn khi tải lên. */
  getCategories: async (dept: string): Promise<Array<{ categoryId: number; name: string }>> => {
    const res = await apiClient.get(`${deptBase(dept)}/categories`);
    return res.data;
  },

  /**
   * idempotencyKey: cùng khóa cho các lần gửi lại của CÙNG một lần tải lên (bấm hai lần, mạng chập chờn rồi gửi lại).
   * Server trả lại đúng tài liệu đã tạo, không tạo tài liệu thứ hai (P3 N6).
   */
  uploadDocument: async (dept: string, formData: FormData, idempotencyKey?: string) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.post(
      endpoint,
      formData,
      idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    );
    return res.data;
  },

  updateDocument: async (
    dept: string,
    docId: number,
    data: { title?: string; description?: string; status?: string; categoryId?: number },
  ) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.put(`${endpoint}/${docId}`, data);
    return res.data;
  },

  approveDocument: async (dept: string, docId: number) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.post(`${endpoint}/${docId}/approve`);
    return res.data;
  },

  getDownloadUrl: (dept: string, docId: number, version?: number) => {
    const endpoint = `${deptBase(dept)}/documents`;
    return version ? `${endpoint}/${docId}/download?version=${version}` : `${endpoint}/${docId}/download`;
  },

  addVersion: async (dept: string, docId: number, formData: FormData) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.post(`${endpoint}/${docId}/versions`, formData);
    return res.data;
  },

  deleteDocument: async (dept: string, docId: number) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.delete(`${endpoint}/${docId}`);
    return res.data;
  },

  download: (dept: string, docId: number, version?: number) =>
    downloadFile(version ? `${deptBase(dept)}/documents/${docId}/download?version=${version}` : `${deptBase(dept)}/documents/${docId}/download`),

  getAuditLogs: async (dept: string, docId: number) => {
    const endpoint = `${deptBase(dept)}/documents`;
    const res = await apiClient.get(`${endpoint}/${docId}/audit-logs`);
    return res.data;
  },
};

// API Tìm kiếm, Chia sẻ & Quy trình phê duyệt cấp quyền
export const searchApi = {
  getCatalog: async (excludeDept?: string): Promise<SearchResultItem[]> => {
    const res = await apiClient.get('/api/search/catalog', { params: { excludeDept } });
    return res.data;
  },

  /** Tải file của phòng KHÁC qua Search Gateway; node chủ sở hữu tự kiểm tra quyền DOWNLOAD và ghi audit. */
  downloadShared: (ownerDept: string, sourceDocId: number | string, version?: number) =>
    downloadFile(
      version
        ? `/api/search/documents/${ownerDept}/${sourceDocId}/download?version=${version}`
        : `/api/search/documents/${ownerDept}/${sourceDocId}/download`,
    ),

  // Người xem (phòng ban, vai trò, Ban Giám đốc) do server lấy từ JWT, không gửi từ client.
  search: async (params: {
    q: string;
    departmentId?: number;
    page?: number;
    limit?: number;
  }): Promise<SearchResponse> => {
    const res = await apiClient.get('/api/search', { params });
    return res.data;
  },

  /** Sổ chia sẻ nằm tại node chủ tài liệu: chỉ gọi được từ phòng của chính mình (Trưởng phòng trở lên). */
  createShare: async (
    ownerDept: string,
    data: { docId: number; sharedWithDept: string; permission?: 'VIEW' | 'DOWNLOAD'; reason?: string; expiresInDays?: number; expiresAt?: string },
  ) => {
    const res = await apiClient.post(`${deptBase(ownerDept)}/shares`, data);
    return res.data;
  },

  getSharedWithMe: async (deptCode: string): Promise<SharesWithDeptResponse> => {
    const res = await apiClient.get('/api/search/shares/shared-with-me', {
      params: { deptCode },
    });
    return res.data;
  },

  getSharesByDept: async (deptCode: string): Promise<SharedDocumentItem[]> => {
    const res = await apiClient.get(`${deptBase(deptCode)}/shares`);
    return res.data;
  },

  revokeShare: async (ownerDept: string, shareId: number) => {
    const res = await apiClient.delete(`${deptBase(ownerDept)}/shares/${shareId}`);
    return res.data;
  },

  getAccessRequests: async (deptCode?: string, isExecutive = false): Promise<AccessRequestItem[]> => {
    const res = await apiClient.get('/api/search/shares/requests', {
      params: { deptCode, isExecutive: isExecutive ? 'true' : 'false' },
    });
    return res.data;
  },

  createAccessRequest: async (data: {
    centralDocId?: number;
    sourceDocId?: number;
    targetDept?: string;
    requesterDept: string;
    requesterUsername: string;
    requestedDays?: number;
    requestedPermission?: 'VIEW' | 'DOWNLOAD';
    reason: string;
  }) => {
    const res = await apiClient.post('/api/search/shares/requests', data);
    return res.data;
  },

  approveAccessRequest: async (
    requestId: number,
    reviewerUsername: string,
    permission?: 'VIEW' | 'DOWNLOAD',
  ) => {
    const res = await apiClient.post(`/api/search/shares/requests/${requestId}/approve`, {
      reviewerUsername,
      permission,
    });
    return res.data;
  },

  rejectAccessRequest: async (requestId: number, reviewerUsername: string, rejectReason?: string) => {
    const res = await apiClient.post(`/api/search/shares/requests/${requestId}/reject`, {
      reviewerUsername,
      rejectReason,
    });
    return res.data;
  },

/** Sức khỏe toàn hệ thống cho trang giám sát của Ban Giám đốc (dữ liệu thật từ Registry, Prometheus, Kafka Connect). */
  getSystemHealth: async (): Promise<SystemHealth> => {
    const res = await apiClient.get('/api/search/executive/system');
    return res.data;
  },

  /** Bản đồ cụm: máy, ai đang giữ vai trò chính, diễn biến chuyển đổi và phục hồi. */
  getClusterMap: async (): Promise<ClusterMap> => {
    const res = await apiClient.get('/api/search/executive/cluster');
    return res.data;
  },

  getExecutiveDashboard: async (): Promise<ExecutiveStats> => {
    const res = await apiClient.get('/api/search/executive/dashboard');
    return res.data;
  },

  getAuditStream: async (limit = 30): Promise<{ total: number; events: AuditStreamItem[]; data?: AuditStreamItem[] }> => {
    const res = await apiClient.get('/api/search/executive/audit-stream', { params: { limit } });
    return {
      total: res.data.total || (res.data.events?.length ?? 0),
      events: res.data.events || res.data.data || [],
      data: res.data.events || res.data.data || [],
    };
  },

  getAnalytics: async (): Promise<{ fileTypes: Array<{ mime_type: string; count: string | number }>; activeShares: unknown[] }> => {
    const res = await apiClient.get('/api/search/executive/analytics');
    // Backend trả fileTypeDistribution / activeSharedDocuments
    return {
      fileTypes: res.data.fileTypes ?? res.data.fileTypeDistribution ?? [],
      activeShares: res.data.activeSharedDocuments ?? [],
    };
  },
};
