#!/usr/bin/env node
/**
 * Script bắn tải rút tiền đồng thời (Dùng cho Bài 1.1, 1.2, 1.3)
 * Chỉ sử dụng fetch và crypto.randomUUID() có sẵn của Node.js (không thêm dependency).
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

function parseArgs(argv) {
  const args = {
    accounts: 1,
    requests: 20,
    amount: 100000,
    initial: 1000000,
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--accounts' && val) {
      args.accounts = parseInt(val, 10);
      i++;
    } else if (key === '--requests' && val) {
      args.requests = parseInt(val, 10);
      i++;
    } else if (key === '--amount' && val) {
      args.amount = parseFloat(val);
      i++;
    } else if (key === '--initial' && val) {
      args.initial = parseFloat(val);
      i++;
    }
  }
  return args;
}

async function requestJson(path, options = {}) {
  const start = performance.now();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const latencyMs = performance.now() - start;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, latencyMs };
}

function calculatePercentile(sortedNumbers, percentile) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.ceil((percentile / 100) * sortedNumbers.length) - 1;
  return sortedNumbers[Math.max(0, Math.min(idx, sortedNumbers.length - 1))];
}

async function setupTestAccount(index, initialBalance) {
  const timestamp = Date.now();
  const email = `load-${timestamp}-${index}-${randomUUID().slice(0, 6)}@bank.local`;
  const password = 'Password@123';

  // 1. Đăng ký user mới
  const regRes = await requestJson('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      fullName: `Load Test User ${index}`,
      email,
      password,
    }),
  });
  if (regRes.status !== 201) {
    throw new Error(
      `Đăng ký thất bại (${regRes.status}): ${JSON.stringify(regRes.body)}`,
    );
  }

  // 2. Đăng nhập lấy JWT
  const loginRes = await requestJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `Đăng nhập thất bại (${loginRes.status}): ${JSON.stringify(loginRes.body)}`,
    );
  }
  const token = loginRes.body.accessToken;

  // 3. Nạp số dư ban đầu qua API deposit
  if (initialBalance > 0) {
    const depRes = await requestJson('/transactions/deposit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        amount: initialBalance.toFixed(2),
        description: 'Initial balance for concurrency load test',
      }),
    });
    if (depRes.status !== 201) {
      throw new Error(
        `Nạp tiền khởi tạo thất bại (${depRes.status}): ${JSON.stringify(depRes.body)}`,
      );
    }
  }

  // 4. Đọc thông tin tài khoản
  const meRes = await requestJson('/accounts/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    index,
    email,
    token,
    accountNumber: meRes.body.accountNumber,
    initialBalance,
    assignedRequests: 0,
  };
}

async function main() {
  const config = parseArgs(process.argv);
  console.log('==========================================================');
  console.log('🚀 KỊCH BẢN BẮN TẢI RÚT TIỀN ĐỒNG THỜI (WITHDRAW LOAD TEST)');
  console.log('==========================================================');
  console.log(`- API URL          : ${API_URL}`);
  console.log(`- Số tài khoản     : ${config.accounts}`);
  console.log(`- Tổng số request  : ${config.requests}`);
  console.log(`- Số dư ban đầu/TK : ${config.initial.toFixed(2)} VND`);
  console.log(`- Số tiền mỗi lần  : ${config.amount.toFixed(2)} VND`);
  console.log('----------------------------------------------------------');

  // Bước 1: Khởi tạo các tài khoản test
  console.log('⏳ Đang khởi tạo tài khoản và nạp số dư ban đầu...');
  const accounts = [];
  for (let i = 0; i < config.accounts; i++) {
    const acc = await setupTestAccount(i + 1, config.initial);
    accounts.push(acc);
  }

  // Bước 2: Chuẩn bị danh sách request chia đều vòng tròn (round-robin)
  const tasks = [];
  for (let r = 0; r < config.requests; r++) {
    const targetAcc = accounts[r % accounts.length];
    targetAcc.assignedRequests += 1;

    tasks.push(() =>
      requestJson('/transactions/withdraw', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${targetAcc.token}`,
          // CẠM BẪY 1: Mỗi request PHẢI có một Idempotency-Key (UUID) riêng biệt
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          amount: config.amount.toFixed(2),
          description: `Concurrent withdraw #${r + 1}`,
        }),
      }).then((res) => ({ ...res, accountIndex: targetAcc.index })),
    );
  }

  // Bước 3: Bắn đồng thời bằng Promise.all
  console.log(`🔥 Đang bắn đồng thời ${config.requests} request rút tiền...`);
  const startTotal = performance.now();
  const results = await Promise.all(tasks.map((fn) => fn()));
  const totalTimeMs = performance.now() - startTotal;

  // Bước 4: Thống kê HTTP status và độ trễ
  const statusCounts = { 201: 0, 422: 0, 409: 0, 503: 0, 500: 0, other: 0 };
  const latencies = [];

  for (const res of results) {
    latencies.push(res.latencyMs);
    if (Object.prototype.hasOwnProperty.call(statusCounts, res.status)) {
      statusCounts[res.status] += 1;
    } else {
      statusCounts.other += 1;
    }
  }

  latencies.sort((a, b) => a - b);
  const avgLatencyMs =
    latencies.reduce((sum, val) => sum + val, 0) / (latencies.length || 1);
  const p95LatencyMs = calculatePercentile(latencies, 95);
  const reqPerSec = (config.requests / (totalTimeMs / 1000)).toFixed(2);

  // Bước 5: Kiểm tra số dư cuối cùng của từng tài khoản
  console.log('\n📊 KẾT QUẢ PHản HỒI & HIỆU NĂNG:');
  console.log(`- HTTP 201 (Thành công)      : ${statusCounts[201]}`);
  console.log(`- HTTP 422 (Không đủ số dư)  : ${statusCounts[422]}`);
  console.log(`- HTTP 409 (Xung đột)        : ${statusCounts[409]}`);
  console.log(`- HTTP 503 (Hệ thống bận)    : ${statusCounts[503]}`);
  console.log(`- HTTP 500 (Lỗi server)      : ${statusCounts[500]}`);
  console.log(`- Mã khác                    : ${statusCounts.other}`);
  console.log(`- Tổng thời gian             : ${totalTimeMs.toFixed(2)} ms`);
  console.log(`- Thông lượng (Throughput)   : ${reqPerSec} req/s`);
  console.log(`- Độ trễ trung bình (Avg)    : ${avgLatencyMs.toFixed(2)} ms`);
  console.log(`- Độ trễ P95                 : ${p95LatencyMs.toFixed(2)} ms`);

  console.log('\n🏦 ĐỐI CHIẾU SỐ DƯ TỪNG TÀI KHOẢN:');
  let allAccountsCorrect = true;
  let totalExpectedSuccess = 0;

  for (const acc of accounts) {
    const meRes = await requestJson('/accounts/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${acc.token}` },
    });
    const actualBalance = parseFloat(meRes.body.balance);
    const maxPossibleWithdrawals = Math.floor(acc.initialBalance / config.amount);
    const expectedSuccessCount = Math.min(
      acc.assignedRequests,
      maxPossibleWithdrawals,
    );
    totalExpectedSuccess += expectedSuccessCount;

    const expectedBalance =
      acc.initialBalance - expectedSuccessCount * config.amount;
    const actualSuccessForAcc = results.filter(
      (r) => r.accountIndex === acc.index && r.status === 201,
    ).length;

    const isBalanceMatch = Math.abs(actualBalance - expectedBalance) < 0.001;
    const isCountMatch = actualSuccessForAcc === expectedSuccessCount;

    if (!isBalanceMatch || !isCountMatch) {
      allAccountsCorrect = false;
    }

    console.log(
      `  [TK #${acc.index} - ${acc.accountNumber}] Request nhận: ${acc.assignedRequests} | ` +
        `201 Kỳ vọng/Thực tế: ${expectedSuccessCount}/${actualSuccessForAcc} | ` +
        `Số dư Kỳ vọng: ${expectedBalance.toFixed(2)} | ` +
        `Số dư Thực tế: ${actualBalance.toFixed(2)} -> ${isBalanceMatch && isCountMatch ? '✅ KHỚP' : '❌ LỆCH'}`,
    );
  }

  const isGlobalCorrect =
    allAccountsCorrect &&
    statusCounts[201] === totalExpectedSuccess &&
    statusCounts[500] === 0;

  console.log('----------------------------------------------------------');
  if (isGlobalCorrect) {
    console.log('✅ KẾT LUẬN CUỐI CÙNG: ĐÚNG (Dữ liệu toàn vẹn tuyệt đối)');
  } else {
    console.log(
      '❌ KẾT LUẬN CUỐI CÙNG: SAI (Xảy ra lỗi Race Condition / Sai lệch số dư!)',
    );
  }
  console.log('==========================================================');
}

main().catch((err) => {
  console.error('Lỗi khi chạy script:', err);
  process.exit(1);
});