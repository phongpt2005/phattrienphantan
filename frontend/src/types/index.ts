export type UserRole = 'MANAGER' | 'STAFF' | 'EXECUTIVE';

export interface UserSession {
  userId?: number;
  username: string;
  fullName: string;
  departmentCode: string; // mã phòng ban lấy từ Registry (không còn giới hạn HR/ACC)
  role: UserRole;
  token: string;
  isExecutive?: boolean;
}

export interface DocumentItem {
  docId: number;
  title: string;
  description?: string;
  categoryId?: number;
  currentVersion: number;
  status: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED' | 'DELETED';
  accessLevel: 'DEPARTMENT' | 'COMPANY' | 'CONFIDENTIAL';
  createdAt: string;
  updatedAt: string;
  creator?: {
    userId: number;
    username: string;
    fullName?: string;
  };
  category?: {
    categoryId: number;
    name?: string;
    categoryName?: string;
  };
  documentTags?: Array<{
    tag: {
      tagId: number;
      tagName: string;
    };
  }>;
}

export interface DocumentVersionFile {
  fileId: string | number;
  fileName: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: string | number;
  checksumSha256: string;
  uploadedAt: string;
}

export interface DocumentVersion {
  versionId?: number;
  docId?: number;
  versionNo: number;
  changeSummary?: string;
  createdAt: string;
  file?: DocumentVersionFile;
  creator?: {
    userId: number;
    username: string;
    fullName?: string;
  };
}

export interface DocumentDetail extends DocumentItem {
  versions?: DocumentVersion[];
}

export interface SharedDocumentItem {
  share_id: number;
  /** Có thể rỗng: sổ chia sẻ nằm ở node chủ, không còn id trung tâm */
  central_doc_id?: number | null;
  source_doc_id?: number;
  shared_by_dept: string;
  shared_by_dept_name?: string;
  shared_with_dept: string;
  permission: 'VIEW' | 'DOWNLOAD';
  reason: string;
  expires_at: string;
  created_at: string;
  title: string;
  description?: string;
  file_name?: string;
  category_name?: string;
  mime_type?: string;
  version_no?: number;
  owner_name?: string;
  tags?: string;
}

export interface AccessRequestItem {
  request_id: number;
  central_doc_id: number;
  source_doc_id?: number;
  requester_dept: string;
  requester_username: string;
  target_dept: string;
  requested_days: number;
  requested_permission?: 'VIEW' | 'DOWNLOAD';
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewed_by?: string;
  reviewed_at?: string;
  created_at: string;
  title: string;
  description?: string;
  file_name?: string;
  category_name?: string;
  mime_type?: string;
}

/** Kết quả "Được chia sẻ với tôi": luôn có phần lấy được, kèm danh sách node không trả lời. */
export interface SharesWithDeptResponse {
  shares: SharedDocumentItem[];
  isPartial: boolean;
  unavailableNodes: string[];
}

export interface SearchResultItem {
  central_doc_id: number;
  department_id: number;
  dept_code: string;
  dept_name: string;
  source_doc_id: number;
  title: string;
  description?: string;
  category_name?: string;
  file_name?: string;
  mime_type?: string;
  version_no: number;
  owner_name?: string;
  access_level: string;
  status: string;
  created_at: string;
  relevance_score?: number;
  highlight_snippet?: string;
  access_mode?: 'OWNER' | 'SHARED' | 'PUBLIC';
  /** Quyền chia sẻ hiệu lực với người xem (khi access_mode = SHARED) */
  share_permission?: 'VIEW' | 'DOWNLOAD' | null;
  /** true: kết quả lấy từ Central Index vì node không trả lời kịp (có thể cũ) */
  stale?: boolean;
  synced_at?: string | null;
  /** true: từ khóa khớp trong nội dung bên trong tệp (không chỉ tiêu đề/mô tả) */
  content_match?: boolean;
}

export interface SearchNodeReport {
  code: string;
  status: 'OK' | 'FALLBACK' | 'UNAVAILABLE';
  tookMs: number;
  reason?: string;
}

export interface SearchResponse {
  total: number;
  data: SearchResultItem[];
  responseTimeMs: number;
  fromCache: boolean;
  /** true nếu có node phải dùng Central Index thay thế (Availability thay vì Consistency) */
  partial?: boolean;
  nodes?: SearchNodeReport[];
  /** Có giá trị khi CSDL chỉ mục trung tâm không đọc được: tìm kiếm vẫn chạy trực tiếp tại các node */
  degraded?: { centralIndex: boolean; snapshotAgeSeconds: number } | null;
  /** Mã vết OpenTelemetry của truy vấn này (tra trên Jaeger) */
  traceId?: string | null;
}

export interface ExecutiveStats {
  overview?: {
    totalActiveDocuments: number;
    systemHealth: string;
    generatedAt: string;
  };
  total_active_documents?: number;
  departments?: Array<{
    department_id: number;
    dept_code: string;
    dept_name: string;
    active_documents: string | number;
    last_synced_at?: string;
  }>;
  department_distribution?: Array<{
    dept_code: string;
    dept_name: string;
    doc_count: number;
  }>;
  documentStatusBreakdown?: Array<{
    status: string;
    count: string | number;
  }>;
  crossDepartmentSharing?: {
    total_shares_created: string | number;
    active_shares: string | number;
    expired_or_revoked_shares: string | number;
  };
  cdcPipelineHealth?: {
    total_cdc_events: string | number;
    successful_events: string | number;
    failed_events: string | number;
    last_event_time: string | null;
  };
}

export interface AuditStreamItem {
  log_id?: number;
  event_id: string;
  dept_code?: string;
  dept_name?: string;
  source_department?: string;
  source_doc_id?: number;
  source_table?: string;
  event_type?: string;
  operation?: 'c' | 'u' | 'd' | string;
  received_at?: string;
  event_timestamp?: string;
  process_status?: string;
  document_title?: string;
  document_status?: string;
  actor?: string;
  payload_preview?: any;
}

export interface DocumentAuditLogEntry {
  logId: number;
  userId?: number;
  docId?: number;
  action: 'CREATE' | 'VIEW' | 'DOWNLOAD' | 'UPDATE' | 'DELETE' | string;
  detail?: string;
  ipAddress?: string;
  createdAt: string;
  user?: {
    userId: number;
    username: string;
    fullName: string;
    role: string;
  };
}

// ---------------------------------------------------------------- Điều hướng
export type AppTab = 'workspace' | 'search' | 'approvals' | 'executive' | 'system' | 'cluster';

// ---------------------------------------------------------------- Bản đồ cụm (theo dõi chuyển đổi và phục hồi)
export interface ClusterMember {
  name: string;
  machine: string;
  status: 'up' | 'down';
  role: string;
  primary: boolean;
  detail?: string;
}
export interface ClusterComponent {
  key: string;
  label: string;
  kind: string;
  leader: string | null;
  leaderMachine: string | null;
  hasLeaderRole: boolean;
  status: 'ok' | 'warn' | 'down';
  detail: string;
  members: ClusterMember[];
}
export interface ClusterMachine {
  id: string;
  label: string;
  address: string | null;
  status: 'up' | 'down';
  memoryUsedPct: number | null;
  cpus: number | null;
  leaders: string[];
  members: Array<ClusterMember & { component: string }>;
}
export interface ClusterEvent {
  id: string;
  at: string;
  kind: 'MACHINE_DOWN' | 'MACHINE_UP' | 'MEMBER_DOWN' | 'MEMBER_UP' | 'LEADER_CHANGED' | 'LEADER_LOST';
  component: string | null;
  member: string | null;
  machine: string | null;
  fromValue: string | null;
  toValue: string | null;
  seconds: number | null;
  message: string;
}
export interface ClusterMap {
  generatedAt: string;
  pollSeconds: number;
  answeredBy: string | null;
  machines: ClusterMachine[];
  components: ClusterComponent[];
  events: ClusterEvent[];
}

// ---------------------------------------------------------------- Giám sát hệ thống (GET /api/search/executive/system)
export type NodeLifecycle = 'PROVISIONING' | 'ACTIVE' | 'DEGRADED' | 'DRAINING' | 'RETIRED';
export type BucketStatus = 'up' | 'down' | 'maintenance' | 'pending' | 'nodata';
export type ComponentStatus = 'ok' | 'warn' | 'down' | 'unknown';

export interface SystemDepartment {
  code: string;
  name: string;
  lifecycle: NodeLifecycle;
  endpoint: string;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  stateSince: string | null;
  stateReason: string | null;
  documents: number;
  lastSyncedAt: string | null;
  searchP95Ms: number | null;
  fallbacks15m: number | null;
  metricsUp: boolean | null;
  buckets: BucketStatus[];
  bucketMinutes: number;
  upSeconds: number;
  downSeconds: number;
  maintenanceSeconds: number;
  trackedSeconds: number;
  availabilityPct: number | null;
}

export interface SystemIncident {
  id: string;
  deptCode: string;
  kind: 'UNPLANNED' | 'PLANNED';
  reason: string | null;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  ongoing: boolean;
}

export interface SystemComponent {
  key: string;
  name: string;
  group: string;
  status: ComponentStatus;
  detail: string;
}

export interface SystemHealth {
  generatedAt: string;
  /** true khi CSDL trung tâm không đọc được: lịch sử sự cố tạm không có */
  centralDbDown?: boolean;
  overall: 'operational' | 'degraded' | 'outage';
  summary: {
    departmentsTotal: number;
    departmentsUp: number;
    downDepartments: string[];
    ongoingIncidents: number;
    incidents24h: number;
  };
  departments: SystemDepartment[];
  incidents: SystemIncident[];
  events: Array<{ id: string; deptCode: string; from: NodeLifecycle | null; to: NodeLifecycle; reason: string | null; at: string }>;
  components: SystemComponent[];
  alerts: Array<{ name: string; severity: string; summary: string; since: string }> | null;
  sources: { prometheus: boolean; kafkaConnect: boolean };
  window: { hours: number; buckets: number; historyDays: number };
}
