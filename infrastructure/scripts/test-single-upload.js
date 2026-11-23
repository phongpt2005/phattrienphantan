const http = require('http');

async function testUpload() {
  // 1. Login lấy token
  const loginRes = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 8000, path: '/api/dept/hr/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.write(JSON.stringify({ username: 'admin', password: 'Admin@123' }));
    req.end();
  });

  const token = loginRes.accessToken;
  console.log('Login OK, Token:', token.substring(0, 30) + '...');

  // 2. Upload file multipart
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const fileContent = 'Noi dung hop dong lao dong thu nghiem 2026';
  
  let body = '';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="title"\r\n\r\n';
  body += 'Hợp đồng lao động mẫu 2026\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="description"\r\n\r\n';
  body += 'Thử nghiệm upload file qua Gateway\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="categoryId"\r\n\r\n';
  body += '1\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="accessLevel"\r\n\r\n';
  body += 'DEPARTMENT\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="file"; filename="hop_dong_test.txt"\r\n';
  body += 'Content-Type: text/plain\r\n\r\n';
  body += fileContent + '\r\n';
  body += '--' + boundary + '--\r\n';

  const uploadRes = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 8000, path: '/api/dept/hr/documents', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.write(body);
    req.end();
  });

  console.log('Upload status:', uploadRes.status);
  console.log('Upload body:', uploadRes.data);
}

testUpload().catch(console.error);
