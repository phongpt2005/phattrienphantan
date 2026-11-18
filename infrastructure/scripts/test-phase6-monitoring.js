const http = require('http');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ THỰC TẾ PHASE 6: MONITORING & PRODUCTION HARDENING ===\n');

  // 1. Tạo traffic qua Gateway
  console.log('1. Đang gửi HTTP requests qua API Gateway (http://localhost:8000)...');
  for (let i = 0; i < 15; i++) {
    await request('http://localhost:8000/health');
    await request('http://localhost:8000/api/search/executive/dashboard');
  }
  console.log('-> Đã gửi thành công 30 requests kích hoạt metrics.');

  // 2. Chờ Prometheus scrape chu kỳ tiếp theo (scrape_interval: 5s)
  console.log('\n2. Chờ 6s để Prometheus hoàn thành chu kỳ cào dữ liệu (scrape cycle)...');
  await new Promise(r => setTimeout(r, 6000));

  // 3. Kiểm tra Prometheus Targets
  try {
    const targetsRes = await request('http://localhost:9090/api/v1/targets');
    if (targetsRes.status === 200 && targetsRes.data.data) {
      console.log('\n3. Trạng thái các Scrape Targets trong Prometheus:');
      const targets = targetsRes.data.data.activeTargets;
      targets.forEach(t => {
        console.log(`   - Job: ${t.labels.job} | Endpoint: ${t.scrapeUrl} | Health: ${t.health} (Scrape time: ${t.lastScrapeDuration}s)`);
      });
    }
  } catch (err) {
    console.log('   [Prometheus chưa sẵn sàng]:', err.message);
  }

  // 4. Truy vấn Metric dms_http_requests_total từ Prometheus
  try {
    const queryRes = await request('http://localhost:9090/api/v1/query?query=sum(dms_http_requests_total)+by+(service,department,status_code)');
    if (queryRes.status === 200 && queryRes.data.data) {
      console.log('\n4. Dữ liệu Metric dms_http_requests_total thu thập được trong Prometheus:');
      queryRes.data.data.result.forEach(r => {
        console.log(`   - ${JSON.stringify(r.metric)} => Giá trị: ${r.value[1]} requests`);
      });
    }
  } catch (err) {
    console.log('   [Query Prometheus error]:', err.message);
  }

  // 5. Kiểm tra Grafana Health
  try {
    const grafanaRes = await request('http://localhost:3000/api/health');
    console.log('\n5. Trạng thái Grafana Dashboard Server:');
    console.log(`   - HTTP Status: ${grafanaRes.status} | Version/DB: ${JSON.stringify(grafanaRes.data)}`);
  } catch (err) {
    console.log('   [Grafana chưa sẵn sàng]:', err.message);
  }

  console.log('\n=== KIỂM THỬ HOÀN TẤT ===');
}

run();
