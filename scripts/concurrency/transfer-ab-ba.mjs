#!/usr/bin/env node
/**
 * Script bắn tải chuyển khoản hai chiều A->B và B->A đồng thời (Bài 1.4)
 * Chỉ sử dụng fetch và crypto.randomUUID() có sẵn của Node.js (không thêm dependency).
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

function parseArgs(argv) {
  const args = {
    pairs: 50,
    rounds: 5,
    amount: 1000,
    initial: 10000000,
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--pairs' && val) {
      args.pairs = parseInt(val, 10);
      i++;
    } else if (key === '--rounds' && val) {
      args.rounds = parseInt(val, 10);
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

async function setupAccount(label, initialBalance) {
  const email = `deadlock-${label}-${Date.now()}-${randomUUID().slice(0, 6)}@bank.local`;
  const password = 'Password@123';

  const regRes = await requestJson('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      fullName: `Deadlock User ${label}`,
      email,
      password,
    }),
  });
  if (regRes.status !== 201) {
    throw new Error(`Đăng ký ${label} thất bại (${regRes.status})`);
  }

  const loginRes = await requestJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status !== 200) {
    throw new Error(`Đăng nhập ${label} thất bại (${loginRes.status})`);
  }
  const token = loginRes.body.accessToken;

  if (initialBalance > 0) {
    const depRes = await requestJson('/transactions/deposit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        amount: initialBalance.toFixed(2),
        description: `Initial balance for ${label}`,
      }),
    });
    if (depRes.status !== 201) {
      throw new Error(`Nạp khởi tạo ${label} thất bại (${depRes.status})`);
    }
  }

  const meRes = await requestJson('/accounts/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    label,
    id: meRes.body.id,
    accountNumber: meRes.body.accountNumber,
    token,
    initialBalance,
  };
}

async function main() {
  const config = parseArgs(process.argv);
  const totalRequestsPerRound = config.pairs * 2;
  const totalRequestsAllRounds = totalRequestsPerRound * config.rounds;

  console.log('==============================================================');
  console.log('🔄 KỊCH BẢN CHUYỂN KHOẢN HAI CHIỀU ĐỒNG THỜI (A <-> B)');
  console.log('==============================================================');
  console.log(`- API URL                 : ${API_URL}`);
  console.log(`- Số cặp mỗi vòng (pairs) : ${config.pairs} cặp (${totalRequestsPerRound} req/vòng)`);
  console.log(`- Số vòng liên tiếp       : ${config.rounds} vòng (Tổng: ${totalRequestsAllRounds} req)`);
  console.log(`- Số dư ban đầu mỗi bên   : ${config.initial.toFixed(2)} VND`);
  console.log(`- Số tiền mỗi lần chuyển  : ${config.amount.toFixed(2)} VND`);
  console.log('--------------------------------------------------------------');

  console.log('⏳ Đang khởi tạo 2 tài khoản A và B...');
  const accA = await setupAccount('A', config.initial);
  const accB = await setupAccount('B', config.initial);
  console.log(`  + Tài khoản A: STK ${accA.accountNumber} (id: ${accA.id})`);
  console.log(`  + Tài khoản B: STK ${accB.accountNumber} (id: ${accB.id})`);

  const statusCounts = { 201: 0, 200: 0, 422: 0, 503: 0, 500: 0, other: 0 };
  let successAtoB = 0;
  let successBtoA = 0;
  const latencies = [];

  const startAll = performance.now();

  for (let round = 1; round <= config.rounds; round++) {
    const tasks = [];

    for (let p = 0; p < config.pairs; p++) {
      // Giao dịch A -> B
      tasks.push(() =>
        requestJson('/transactions/transfer', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accA.token}`,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            toAccountNumber: accB.accountNumber,
            amount: config.amount.toFixed(2),
            description: `Round ${round} Pair ${p + 1} A->B`,
          }),
        }).then((res) => ({ ...res, direction: 'AtoB' })),
      );

      // Giao dịch B -> A (ngược chiều tại cùng thời điểm)
      tasks.push(() =>
        requestJson('/transactions/transfer', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accB.token}`,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            toAccountNumber: accA.accountNumber,
            amount: config.amount.toFixed(2),
            description: `Round ${round} Pair ${p + 1} B->A`,
          }),
        }).then((res) => ({ ...res, direction: 'BtoA' })),
      );
    }

    const roundStart = performance.now();
    const roundResults = await Promise.all(tasks.map((fn) => fn()));
    const roundTimeMs = performance.now() - roundStart;

    let round201 = 0;
    let round503 = 0;
    let round500 = 0;

    for (const r of roundResults) {
      latencies.push(r.latencyMs);
      if (Object.prototype.hasOwnProperty.call(statusCounts, r.status)) {
        statusCounts[r.status] += 1;
      } else {
        statusCounts.other += 1;
      }

      if (r.status === 201 || r.status === 200) {
        round201 += 1;
        if (r.direction === 'AtoB') successAtoB += 1;
        else successBtoA += 1;
      } else if (r.status === 503) {
        round503 += 1;
      } else if (r.status === 500) {
        round500 += 1;
      }
    }

    console.log(
      `  [Vòng ${round}/${config.rounds}] Xong trong ${roundTimeMs.toFixed(0)} ms | ` +
        `Thành công (201): ${round201}/${totalRequestsPerRound} | 503: ${round503} | 500: ${round500}`,
    );
  }

  const totalTimeMs = performance.now() - startAll;
  const avgLatencyMs =
    latencies.reduce((s, v) => s + v, 0) / (latencies.length || 1);

  // Kiểm tra số dư cuối cùng của A và B
  const finalARes = await requestJson('/accounts/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accA.token}` },
  });
  const finalBRes = await requestJson('/accounts/me', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accB.token}` },
  });

  const actualBalanceA = parseFloat(finalARes.body.balance);
  const actualBalanceB = parseFloat(finalBRes.body.balance);

  const expectedBalanceA =
    config.initial -
    successAtoB * config.amount +
    successBtoA * config.amount;
  const expectedBalanceB =
    config.initial -
    successBtoA * config.amount +
    successAtoB * config.amount;

  const expectedTotalSum = config.initial * 2;
  const actualTotalSum = actualBalanceA + actualBalanceB;

  const isSumConserved = Math.abs(actualTotalSum - expectedTotalSum) < 0.001;
  const isAMatch = Math.abs(actualBalanceA - expectedBalanceA) < 0.001;
  const isBMatch = Math.abs(actualBalanceB - expectedBalanceB) < 0.001;
  const isNo500 = statusCounts[500] === 0;

  console.log('\n📊 TỔNG HỢP KẾT QUẢ SAU CÁC VÒNG:');
  console.log(`- HTTP 201 (Thành công)     : ${statusCounts[201]}`);
  console.log(`  + Chiều A -> B thành công : ${successAtoB}`);
  console.log(`  + Chiều B -> A thành công : ${successBtoA}`);
  console.log(`- HTTP 503 (Hệ thống bận)   : ${statusCounts[503]}`);
  console.log(`- HTTP 500 (Lỗi server)     : ${statusCounts[500]}`);
  console.log(`- Tổng thời gian            : ${totalTimeMs.toFixed(2)} ms`);
  console.log(`- Độ trễ trung bình         : ${avgLatencyMs.toFixed(2)} ms`);

  console.log('\n🏦 KIỂM TRA BẢO TOÀN SỐ DƯ:');
  console.log(
    `  + Tài khoản A: Kỳ vọng = ${expectedBalanceA.toFixed(2)} | Thực tế = ${actualBalanceA.toFixed(2)} -> ${isAMatch ? '✅ KHỚP' : '❌ LỆCH'}`,
  );
  console.log(
    `  + Tài khoản B: Kỳ vọng = ${expectedBalanceB.toFixed(2)} | Thực tế = ${actualBalanceB.toFixed(2)} -> ${isBMatch ? '✅ KHỚP' : '❌ LỆCH'}`,
  );
  console.log(
    `  + Tổng (A + B): Ban đầu = ${expectedTotalSum.toFixed(2)} | Cuối cùng = ${actualTotalSum.toFixed(2)} -> ${isSumConserved ? '✅ BẢO TOÀN' : '❌ LỆCH TỔNG'}`,
  );

  console.log('--------------------------------------------------------------');
  if (isNo500 && isSumConserved && isAMatch && isBMatch) {
    console.log(
      '✅ KẾT LUẬN CUỐI CÙNG: ĐÚNG (Không lỗi 500, tổng tiền bảo toàn tuyệt đối)',
    );
  } else {
    console.log('❌ KẾT LUẬN CUỐI CÙNG: SAI (Có lỗi 500 hoặc sai lệch số dư!)');
  }
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('Lỗi khi chạy script A<->B:', err);
  process.exit(1);
});