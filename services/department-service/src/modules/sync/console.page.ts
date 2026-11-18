export const CONSOLE_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Node phòng ban - Trạng thái đồng bộ</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --ok:#065f46; --okbg:#ecfdf5; --okb:#a7f3d0; --off:#92400e; --offbg:#fffbeb; --offb:#fde68a; }
  body { margin:0; font:14px/1.4 system-ui, sans-serif; color:var(--ink); background:var(--bg); }
  header { background:#fff; border-bottom:1px solid var(--line); padding:12px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; }
  main { padding:16px 20px; max-width:1100px; margin:0 auto; }
  .badge { display:inline-block; font:700 12px/1 ui-monospace, monospace; padding:6px 10px; border-radius:4px; border:1px solid; letter-spacing:.2px; }
  .online { color:var(--ok); background:var(--okbg); border-color:var(--okb); }
  .offline { color:var(--off); background:var(--offbg); border-color:var(--offb); }
  .panel { background:#fff; border:1px solid var(--line); border-radius:4px; margin-bottom:14px; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0; padding:9px 14px; border-bottom:1px solid var(--line); background:#f1f5f9; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:0; }
  .cell { padding:12px 14px; border-right:1px solid var(--line); }
  .cell:last-child { border-right:0; }
  .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .v { font:600 18px ui-monospace, monospace; margin-top:4px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 14px; border-bottom:1px solid var(--line); font-size:13px; }
  th { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  input { padding:7px 9px; border:1px solid #cbd5e1; border-radius:4px; font:inherit; }
  button { padding:7px 12px; border:1px solid #0f172a; background:#0f172a; color:#fff; border-radius:4px; font:600 13px inherit; cursor:pointer; }
  .muted { color:var(--muted); font-size:12px; }
  .err { color:#b91c1c; font-size:13px; }
  .row { display:flex; gap:8px; align-items:center; padding:12px 14px; flex-wrap:wrap; }
  @media (max-width:640px) { main { padding:12px; } .cell { border-right:0; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1 id="title">Node phòng ban</h1>
  <span id="badge" class="badge offline">ĐANG KIỂM TRA...</span>
</header>
<main>
  <div class="panel">
    <h2>Trạng thái đồng bộ</h2>
    <div class="grid">
      <div class="cell"><div class="k">Kết nối trung tâm</div><div class="v" id="central">—</div></div>
      <div class="cell"><div class="k">Liên lạc gần nhất</div><div class="v" id="lastok" style="font-size:13px">—</div></div>
      <div class="cell"><div class="k">Sự kiện trong thời gian cắt</div><div class="v" id="recent">—</div></div>
      <div class="cell"><div class="k">Chờ gửi lên trung tâm</div><div class="v" id="backlog">—</div></div>
    </div>
    <div class="muted" style="padding:0 14px 12px" id="explain"></div>
  </div>

  <div class="panel" id="loginpanel">
    <h2>Đăng nhập cục bộ</h2>
    <div class="row">
      <input id="u" placeholder="tài khoản" autocomplete="username">
      <input id="p" type="password" placeholder="mật khẩu" autocomplete="current-password">
      <button id="login">Đăng nhập</button>
      <span class="err" id="loginerr"></span>
    </div>
  </div>

  <div class="panel" id="docpanel" hidden>
    <h2>Tài liệu của phòng (đọc từ CSDL cục bộ)</h2>
    <table>
      <thead><tr><th>Mã</th><th>Tiêu đề</th><th>Phiên bản</th><th>Ngày tạo</th></tr></thead>
      <tbody id="docs"><tr><td colspan="4" class="muted">Chưa tải</td></tr></tbody>
    </table>
  </div>
</main>
<script>
(function () {
  var token = null;
  var $ = function (id) { return document.getElementById(id); };
  function fmt(n) { return Number(n || 0).toLocaleString('vi-VN'); }
  function bytes(b) { if (b == null) return 'không đọc được'; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' kB'; return (b / 1048576).toFixed(1) + ' MB'; }
  function ago(s) { if (s == null) return '—'; if (s < 90) return s + ' giây trước'; return Math.round(s / 60) + ' phút trước'; }

  function paint(s) {
    $('title').textContent = 'Node phòng ' + s.department;
    var b = $('badge');
    if (s.mode === 'OFFLINE') {
      b.className = 'badge offline';
      b.textContent = 'CHẾ ĐỘ TỰ TRỊ (OFFLINE) - DỮ LIỆU ĐANG LƯU NỘI BỘ';
    } else {
      b.className = 'badge online';
      b.textContent = 'ĐỒNG BỘ VỚI TRUNG TÂM';
    }
    $('central').textContent = s.centralReachable ? 'Có' : 'Mất';
    $('lastok').textContent = s.lastCentralOkAt ? new Date(s.lastCentralOkAt).toLocaleTimeString('vi-VN') : 'chưa có';
    $('recent').textContent = fmt(s.outbox.rowsLast15m);
    $('backlog').textContent = bytes(s.outbox.backlogBytes);
    var msg = s.mode === 'OFFLINE'
      ? 'Phòng đang làm việc độc lập. Mọi thay đổi được lưu vào CSDL cục bộ và sẽ tự gửi lên trung tâm khi nối lại mạng (không mất dữ liệu).'
      : 'Mọi thay đổi đã được đẩy lên trung tâm hoặc đang chờ gửi trong thời gian rất ngắn.';
    $('explain').textContent = msg;
  }

  function status() {
    fetch('/sync/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(paint)
      .catch(function () {
        var b = $('badge'); b.className = 'badge offline';
        b.textContent = 'KHÔNG ĐỌC ĐƯỢC TRẠNG THÁI NODE';
      });
  }

  function loadDocs() {
    fetch('/documents?limit=50', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var rows = (d.data || d.items || d || []);
        if (!Array.isArray(rows)) rows = [];
        $('docs').innerHTML = rows.length ? rows.map(function (x) {
          return '<tr><td>#' + x.docId + '</td><td>' + String(x.title).replace(/</g, '&lt;') + '</td><td>v' + x.currentVersion + '</td><td>' + new Date(x.createdAt).toLocaleDateString('vi-VN') + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="muted">Chưa có tài liệu</td></tr>';
        $('docpanel').hidden = false;
      });
  }

  $('login').onclick = function () {
    $('loginerr').textContent = '';
    fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('u').value, password: $('p').value }) })
      .then(function (r) { if (!r.ok) throw new Error('sai tài khoản hoặc mật khẩu'); return r.json(); })
      .then(function (j) { token = j.accessToken; $('loginerr').textContent = ''; loadDocs(); })
      .catch(function (e) { $('loginerr').textContent = e.message; });
  };

  status();
  setInterval(status, 3000);
})();
</script>
</body>
</html>`;
