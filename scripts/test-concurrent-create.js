const http = require('http');

function login() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: 'admin', password: 'admin123' });
    const req = http.request(
      { hostname: 'localhost', port: 3912, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(JSON.parse(body).token));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function createPlan(token, caveEncoded, zoneEncoded) {
  return new Promise((resolve) => {
    const data = JSON.stringify({});
    const path = `/api/zone-create-plan/${caveEncoded}/${zoneEncoded}`;
    const req = http.request(
      { hostname: 'localhost', port: 3912, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Authorization': 'Bearer ' + token } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(data);
    req.end();
  });
}

async function test() {
  const token = await login();
  const caveEncoded = encodeURIComponent('西麓二号洞');
  const zoneEncoded = encodeURIComponent('流石坝区');
  
  console.log('并发发送 5 个创建请求（西麓二号洞 / 流石坝区）...\n');
  const results = await Promise.all([
    createPlan(token, caveEncoded, zoneEncoded),
    createPlan(token, caveEncoded, zoneEncoded),
    createPlan(token, caveEncoded, zoneEncoded),
    createPlan(token, caveEncoded, zoneEncoded),
    createPlan(token, caveEncoded, zoneEncoded)
  ]);
  
  console.log('各请求结果:');
  results.forEach((r, i) => {
    try {
      const body = JSON.parse(r.body);
      console.log(`  请求 ${i + 1}: HTTP ${r.status} - ${body.error || (body.note ? '创建成功' : 'OK')}`);
    } catch (e) {
      console.log(`  请求 ${i + 1}: HTTP ${r.status} - ${r.body.slice(0, 80)}`);
    }
  });
  
  const successCount = results.filter(r => r.status === 201).length;
  const conflictCount = results.filter(r => r.status === 409).length;
  console.log(`\n成功创建: ${successCount} 个`);
  console.log(`冲突拒绝: ${conflictCount} 个`);
  console.log(`\n验证: 应当只有 1 个成功创建，其余被拒绝`);
  console.log(`结果: ${successCount === 1 ? '✅ 通过' : '❌ 失败'}`);
}

test().catch(console.error);
