const HR_URL = 'http://localhost:3001';
const ACC_URL = 'http://localhost:3002';
const SEARCH_URL = 'http://localhost:3003';

async function main() {
  console.log('=== [TEST] BẮT ĐẦU KIỂM THỬ VÒNG ĐỜI TOÀN DIỆN DMS ENTERPRISE ===\n');

  // 1. Đăng nhập các tài khoản
  console.log('1. Đăng nhập các tài khoản: hr_staff, hr_manager, acc_manager...');
  const hrStaffLogin = await fetch(`${HR_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'hr_staff', password: 'Staff@123' }),
  }).then(r => r.json());
  const hrStaffToken = hrStaffLogin.accessToken;

  const hrMgrLogin = await fetch(`${HR_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'hr_manager', password: 'Admin@123' }),
  }).then(r => r.json());
  const hrMgrToken = hrMgrLogin.accessToken;

  const accMgrLogin = await fetch(`${ACC_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'acc_manager', password: 'Admin@123' }),
  }).then(r => r.json());
  const accMgrToken = accMgrLogin.accessToken;
  console.log('   => Đăng nhập thành công, nhận Bearer JWT tokens.\n');

  // 2. Nhân viên HR tạo văn bản mới (Kỳ vọng: Status = DRAFT)
  console.log('2. hr_staff tải lên tài liệu mới "Quy chế khen thưởng quý 4 (Bản thảo)..."');
  const formData = new FormData();
  formData.append('title', `Quy chế khen thưởng quý 4 - ${Date.now()}`);
  formData.append('description', 'Bản thảo chính sách do nhân viên HR lập, chờ Trưởng phòng thẩm duyệt.');
  formData.append('accessLevel', 'DEPARTMENT');
  formData.append('file', new Blob(['Noi dung van ban quy che khen thuong Q4 enterprise...'], { type: 'text/plain' }), 'quy_che_khen_thuong_q4.txt');

  const uploadRes = await fetch(`${HR_URL}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${hrStaffToken}`,
    },
    body: formData,
  }).then(r => r.json());

  console.log('Upload response:', uploadRes);
  const doc = uploadRes;
  console.log(`   => Văn bản tạo thành công! ID: #DOC-${doc.docId}, Status: "${doc.status}" (Kỳ vọng: DRAFT)`);
  if (doc.status !== 'DRAFT') {
    throw new Error(`Kỳ vọng status = DRAFT nhưng nhận được: ${doc.status}`);
  }

  // 3. Trưởng phòng kiểm tra Vết kiểm toán ban đầu (Audit Trail)
  console.log(`\n3. hr_manager truy xuất vết kiểm toán của tài liệu #DOC-${doc.docId}...`);
  const initialAuditRes = await fetch(`${HR_URL}/documents/${doc.docId}/audit-logs`, {
    headers: { Authorization: `Bearer ${hrMgrToken}` },
  }).then(r => r.json());
  console.log(`   => Nhận được ${initialAuditRes.length} bản ghi kiểm toán.`);
  console.log(`   => Sự kiện đầu tiên: Action [${initialAuditRes[0].action}], Người thực hiện: ${initialAuditRes[0].user?.fullName} (@${initialAuditRes[0].user?.username}), Chi tiết: "${initialAuditRes[0].detail}"`);

  // 4. Trưởng phòng HR Ký duyệt ban hành hồ sơ (Approve Draft -> PUBLISHED)
  console.log(`\n4. hr_manager Ký duyệt ban hành tài liệu #DOC-${doc.docId}...`);
  const approveRes = await fetch(`${HR_URL}/documents/${doc.docId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hrMgrToken}` },
  }).then(r => r.json());
  console.log(`   => Ký duyệt thành công! Status mới: "${approveRes.status}" (Kỳ vọng: PUBLISHED)`);
  if (approveRes.status !== 'PUBLISHED') {
    throw new Error(`Kỳ vọng status = PUBLISHED nhưng nhận được: ${approveRes.status}`);
  }

  // 5. Trưởng phòng Kế toán (acc_manager) gửi đơn xin cấp quyền tải về văn bản này
  console.log(`\n5. acc_manager gửi đơn xin cấp quyền DOWNLOAD gửi sang Phòng HR...`);
  // Đợi 1 giây để đảm bảo CDC sync
  await new Promise(r => setTimeout(r, 1000));
  const reqRes = await fetch(`${SEARCH_URL}/search/shares/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDocId: Number(doc.docId),
      targetDept: 'HR',
      requesterDept: 'ACC',
      requesterUsername: 'acc_manager',
      requestedDays: 14,
      requestedPermission: 'DOWNLOAD',
      reason: 'Phòng Kế toán đối chiếu ngân sách giải ngân khen thưởng',
    }),
  }).then(r => r.json());

  console.log('Access Request Response:', reqRes);
  const accessReq = reqRes.request;
  console.log(`   => Đơn xin quyền tạo thành công! ID: #REQ-${accessReq.request_id}, Trạng thái: "${accessReq.status}" (PENDING)`);

  // 6. Trưởng phòng HR phê duyệt cấp quyền DOWNLOAD
  console.log(`\n6. hr_manager phê chuẩn đơn #REQ-${accessReq.request_id} với quyền DOWNLOAD...`);
  const crossApproveRes = await fetch(`${SEARCH_URL}/search/shares/requests/${accessReq.request_id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewerUsername: 'hr_manager',
      permission: 'DOWNLOAD',
    }),
  }).then(r => r.json());
  console.log(`   => Phê duyệt liên phòng ban thành công: ${crossApproveRes.message}`);

  // 7. Phòng Kế toán kiểm tra kho văn bản được chia sẻ (Shared-with-me)
  console.log(`\n7. acc_manager truy vấn kho tài liệu thụ hưởng (/search/shares/shared-with-me?deptCode=ACC)...`);
  const sharedRes = await fetch(`${SEARCH_URL}/search/shares/shared-with-me?deptCode=ACC`).then(r => r.json());
  const foundShared = sharedRes.find((s) => Number(s.source_doc_id) === Number(doc.docId) || s.title === doc.title);
  if (!foundShared) {
    throw new Error('Không tìm thấy tài liệu vừa duyệt trong danh sách shared-with-me của Phòng ACC!');
  }
  console.log(`   => Tìm thấy văn bản được ủy quyền: "${foundShared.title}"`);
  console.log(`      + Quyền hạn được cấp: [${foundShared.permission}] (DLP DOWNLOAD)`);
  console.log(`      + Thời hạn hiệu lực: Đến ngày ${new Date(foundShared.expires_at).toLocaleString('vi-VN')}`);
  console.log(`      + Phòng ban cấp: ${foundShared.shared_by_dept}`);

  // 8. Tự động kiểm tra quét hạn chia sẻ
  console.log(`\n8. Kích hoạt quét tự động dọn dẹp các liên kết chia sẻ quá hạn...`);
  const cleanupRes = await fetch(`${SEARCH_URL}/search/shares/cleanup-expired`, {
    method: 'POST',
  }).then(r => r.json());
  console.log(`   => Kết quả quét: Đã thu hồi ${cleanupRes.revokedCount} bản ghi quá hạn.`);

  // 9. Kiểm tra vết kiểm toán đầy đủ sau toàn bộ chu trình
  console.log(`\n9. Kiểm tra lại toàn bộ Vết kiểm toán của tài liệu #DOC-${doc.docId}...`);
  const finalAuditRes = await fetch(`${HR_URL}/documents/${doc.docId}/audit-logs`, {
    headers: { Authorization: `Bearer ${hrMgrToken}` },
  }).then(r => r.json());
  console.log(`   => Tổng số sự kiện kiểm toán: ${finalAuditRes.length}`);
  finalAuditRes.forEach((entry, i) => {
    console.log(`      [#${i + 1}] ${entry.action.padEnd(8)} | ${entry.createdAt} | ${entry.user?.fullName} (@${entry.user?.username}) | ${entry.detail}`);
  });

  console.log('\n=== TẤT CẢ KIỂM THỬ VÒNG ĐỜI VÀ PHÂN TÁN ĐÃ HOÀN TẤT THÀNH CÔNG 100%! ===');
}

main().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
