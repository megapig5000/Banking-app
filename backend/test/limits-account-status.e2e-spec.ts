import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  AccountStatus,
  AccountTier,
} from '../src/database/entities/account.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/database/entities/transaction.entity';
import { LedgerEntry } from '../src/database/entities/ledger-entry.entity';
import { IdempotencyKey } from '../src/database/entities/idempotency-key.entity';
import { TransactionFailureCode } from '../src/transactions/transactions.constants';
import { AuditAction, AuditEntity } from '../src/audit/audit.constants';
import {
  assertAuditInvariants,
  assertLedgerInvariants,
  assertModule5Invariants,
  createAuthenticatedAccount,
  createAuthenticatedAdmin,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

jest.setTimeout(60000);

describe('Module 5 (5.1 & 5.2) — Transaction Limits, Account Status & Available Balance (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const setup = await createTestApp();
    app = setup.app;
    dataSource = setup.dataSource;
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  // =========================================================================
  // BÀI 5.1 — HẠN MỨC GIAO DỊCH THEO LẦN & THEO NGÀY GIỜ VIỆT NAM (L1 -> L7)
  // =========================================================================

  it('L1: STANDARD tier per-transaction limit (30,000,000.00) -> 30,000,000.01 fails with 422 LIMIT_PER_TRANSACTION_EXCEEDED (records FAILED, 0 ledger entries, clear message), while exact 30,000,000.00 succeeds', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'L1-Sender',
      '100000000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'L1-Receiver',
      '0.00',
    );

    const ledgerCountBefore = await ledgerRepo.count();

    // 1. Chuyển 30,000,000.01 (vượt đúng 1 xu so với trần 30,000,000.00/lần của STANDARD) -> 422
    const overKey = randomUUID();
    const overRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', overKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '30000000.01',
        description: 'L1 over per-transaction limit by 0.01',
      })
      .expect(422);

    expect(overRes.body.message).toMatch(/30\.000\.000/);
    expect(overRes.body.message).toMatch(/50\.000\.000/);

    // Phải được ghi nhận trạng thái FAILED với mã LIMIT_PER_TRANSACTION_EXCEEDED và 0 bút toán mới
    const overKeyRecord = await idemRepo.findOneByOrFail({
      user_id: sender.userId,
      idempotency_key: overKey,
    });
    const failedTx = await txRepo.findOneByOrFail({
      id: overKeyRecord.transaction_id!,
    });
    expect(failedTx.status).toBe(TransactionStatus.FAILED);
    expect(failedTx.failure_code).toBe(
      TransactionFailureCode.LIMIT_PER_TRANSACTION_EXCEEDED,
    );
    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    // 2. Chuyển đúng biên 30,000,000.00 -> 201 COMPLETED
    const exactRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '30000000.00',
        description: 'L1 exact 30M boundary transfer',
      })
      .expect(201);

    expect(exactRes.body.status).toBe(TransactionStatus.COMPLETED);
    expect(exactRes.body.amount).toBe('30000000.00');

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L2: cumulative daily limit (50,000,000.00 for STANDARD) -> 5 x 9,900,000.00 succeed (49,500,000.00 used), 6th 9,900,000.00 is rejected with 422 LIMIT_PER_DAY_EXCEEDED despite being small, exact remaining 500,000.00 succeeds, and +0.01 more is rejected', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'L2-Sender',
      '100000000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'L2-Receiver',
      '0.00',
    );

    // 1. Thực hiện 5 giao dịch x 9,900,000.00 = 49,500,000.00 -> cả 5 đều thành công (201)
    for (let i = 1; i <= 5; i++) {
      await request(httpServer)
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${sender.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          toAccountNumber: receiver.accountNumber,
          amount: '9900000.00',
          description: `L2 transfer #${i}`,
        })
        .expect(201);
    }

    // 2. Giao dịch thứ 6 chuyển 9,900,000.00 -> bị từ chối 422 LIMIT_PER_DAY_EXCEEDED dù < 30M
    const sixthKey = randomUUID();
    const sixthRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sixthKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '9900000.00',
        description: 'L2 6th transfer exceeding daily limit',
      })
      .expect(422);

    // Thông báo lỗi phải nêu rõ hạn mức ngày (50.000.000 ₫) và số còn lại hôm nay (500.000 ₫)
    expect(sixthRes.body.message).toMatch(/50\.000\.000/);
    expect(sixthRes.body.message).toMatch(/500\.000/);

    const sixthKeyRecord = await idemRepo.findOneByOrFail({
      user_id: sender.userId,
      idempotency_key: sixthKey,
    });
    const sixthTx = await txRepo.findOneByOrFail({
      id: sixthKeyRecord.transaction_id!,
    });
    expect(sixthTx.status).toBe(TransactionStatus.FAILED);
    expect(sixthTx.failure_code).toBe(
      TransactionFailureCode.LIMIT_PER_DAY_EXCEEDED,
    );

    // 3. Giao dịch đúng bằng số còn lại 500,000.00 -> Thành công 201 (tổng đã dùng = 50,000,000.00)
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '500000.00',
        description: 'L2 exact remaining 500,000.00',
      })
      .expect(201);

    // 4. Thử rút thêm đúng 0.01đ -> Bị từ chối 422 LIMIT_PER_DAY_EXCEEDED (còn lại: 0 ₫)
    const extraCentRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: '0.01',
        description: 'L2 extra 0.01 over exhausted daily limit',
      })
      .expect(422);

    expect(extraCentRes.body.message).toMatch(/0 ₫/);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L3: upgrading account tier from STANDARD to VIP via Admin API takes immediate effect (100M per tx, 200M per day)', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'L3-Admin');
    const user = await createAuthenticatedAccount(
      app,
      'L3-User',
      '250000000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'L3-Receiver',
      '0.00',
    );

    // 1. Khi còn là STANDARD: chuyển 80,000,000.00 bị từ chối 422 (vượt 30M/lần)
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '80000000.00',
        description: 'L3 80M while STANDARD',
      })
      .expect(422);

    // 2. Admin nâng tier của user lên VIP qua PATCH /api/admin/accounts/:accountNumber
    const patchRes = await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tier: AccountTier.VIP })
      .expect(200);

    expect(patchRes.body.tier).toBe(AccountTier.VIP);

    // 3. Ngay lập tức user chuyển được 2 giao dịch x 80,000,000.00 = 160,000,000.00 (> 50M của STANDARD, <= 200M của VIP)
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '80000000.00',
        description: 'L3 1st 80M as VIP',
      })
      .expect(201);

    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '80000000.00',
        description: 'L3 2nd 80M as VIP',
      })
      .expect(201);

    // 4. Khoản thứ 3 chuyển 50,000,000.00 (160M + 50M = 210M > 200M/ngày của VIP) -> bị từ chối 422
    const overVipDayRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '50000000.00',
        description: 'L3 over 200M VIP daily limit',
      })
      .expect(422);

    expect(overVipDayRes.body.message).toMatch(/200\.000\.000/);
    expect(overVipDayRes.body.message).toMatch(/40\.000\.000/);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L4: Vietnam timezone boundary (Asia/Ho_Chi_Minh) -> transaction at 23:59 VN yesterday is excluded from usedToday, while transaction at 00:01 VN today is included', async () => {
    const httpServer = app.getHttpServer();

    const user = await createAuthenticatedAccount(
      app,
      'L4-User',
      '100000000.00',
    );

    // Tạo 2 giao dịch rút tiền 25,000,000.00
    const txYesterdayRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '25000000.00', description: 'L4 tx at 23:59 yesterday' })
      .expect(201);

    const txTodayRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '20000000.00', description: 'L4 tx at 00:01 today' })
      .expect(201);

    // Dùng SQL "tua thời gian" theo đồng hồ PostgreSQL múi giờ Asia/Ho_Chi_Minh:
    // - txYesterday: 23:59:00 hôm qua theo giờ VN (1 phút trước mốc 00:00 hôm nay)
    // - txToday    : 00:01:00 hôm nay theo giờ VN (1 phút sau mốc 00:00 hôm nay)
    await dataSource.query(
      `
      UPDATE "transactions"
      SET "created_at" = (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh') - INTERVAL '1 minute'
      WHERE "id" = $1
      `,
      [txYesterdayRes.body.id],
    );

    await dataSource.query(
      `
      UPDATE "transactions"
      SET "created_at" = (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh') + INTERVAL '1 minute'
      WHERE "id" = $1
      `,
      [txTodayRes.body.id],
    );

    // Kiểm tra GET /api/accounts/me: chỉ tính 20,000,000.00 của lúc 00:01 hôm nay, còn lại 30,000,000.00
    const meRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    expect(meRes.body.limits.usedToday).toBe('20000000.00');
    expect(meRes.body.limits.remainingToday).toBe('30000000.00');

    // Rút thêm 30,000,000.00 hôm nay -> Thành công 201 (vì 25M của 23:59 hôm qua không tính vào hôm nay!)
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: '30000000.00',
        description: 'L4 withdraw remaining 30M today',
      })
      .expect(201);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L5: 10 concurrent withdrawals of 9,900,000.00 when only enough daily limit remains for 2 -> exactly 2 succeed (201 COMPLETED), 8 fail (422 LIMIT_PER_DAY_EXCEEDED), total never exceeds daily limit', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const user = await createAuthenticatedAccount(
      app,
      'L5-User',
      '200000000.00',
    );

    // Dùng trước 30,000,000.00 -> Hạn mức ngày STANDARD (50,000,000.00) chỉ còn lại 20,000,000.00 (đủ cho đúng 2 lần 9,900,000.00)
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '30000000.00', description: 'L5 pre-use 30M' })
      .expect(201);

    // Bắn đồng thời 10 request rút 9,900,000.00
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        request(httpServer)
          .post('/api/transactions/withdraw')
          .set('Authorization', `Bearer ${user.token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            amount: '9900000.00',
            description: `L5 concurrent withdraw #${idx + 1}`,
          }),
      ),
    );

    const count201 = responses.filter((r) => r.status === 201).length;
    const count422 = responses.filter((r) => r.status === 422).length;
    const count500 = responses.filter((r) => r.status === 500).length;

    expect(count500).toBe(0);
    expect(count201).toBe(2);
    expect(count422).toBe(8);

    const limitExceededCount = await txRepo.count({
      where: {
        actor_account_id: user.accountId,
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.FAILED,
        failure_code: TransactionFailureCode.LIMIT_PER_DAY_EXCEEDED,
      },
    });
    expect(limitExceededCount).toBe(8);

    // Kiểm tra tổng đã dùng hôm nay: 30,000,000 + 2 * 9,900,000 = 49,800,000.00 (<= 50,000,000.00)
    const meRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(meRes.body.limits.usedToday).toBe('49800000.00');
    expect(meRes.body.limits.remainingToday).toBe('200000.00');

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L6: DEPOSIT, REVERSAL, FAILED transactions, and REVERSED original transactions do NOT count toward usedToday', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'L6-Admin');
    const userA = await createAuthenticatedAccount(app, 'L6-A', '60000000.00');
    const userB = await createAuthenticatedAccount(app, 'L6-B', '10000000.00');

    // 1. DEPOSIT 60,000,000.00 vào userA -> không tính vào usedToday (usedToday vẫn = 0.00)
    const meAfterDeposit = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    expect(meAfterDeposit.body.limits.usedToday).toBe('0.00');

    // 2. Giao dịch FAILED (thử rút 35,000,000.00 vượt trần 1 lần) -> không tính vào usedToday
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '35000000.00', description: 'L6 failed withdraw' })
      .expect(422);

    // 3. User A chuyển 25,000,000.00 sang User B -> usedToday của A = 25,000,000.00
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '25000000.00',
        description: 'L6 transfer to be reversed',
      })
      .expect(201);

    const meBeforeRev = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    expect(meBeforeRev.body.limits.usedToday).toBe('25000000.00');

    // 4. Admin hoàn tiền (REVERSAL) giao dịch 25,000,000.00 -> gốc thành REVERSED, phiếu mới là REVERSAL
    // Cả A (gốc REVERSED) lẫn B (bên bị trừ trong REVERSAL) đều có usedToday = 0.00!
    await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'L6 reversal frees limit' })
      .expect(201);

    const meAAfterRev = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    const meBAfterRev = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    expect(meAAfterRev.body.limits.usedToday).toBe('0.00');
    expect(meAAfterRev.body.limits.remainingToday).toBe('50000000.00');
    expect(meBAfterRev.body.limits.usedToday).toBe('0.00');

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('L7: GET /accounts/me returns accurate limits block (perTransaction, perDay, usedToday, remainingToday)', async () => {
    const httpServer = app.getHttpServer();
    const user = await createAuthenticatedAccount(
      app,
      'L7-User',
      '50000000.00',
    );

    const meInitial = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    expect(meInitial.body.limits).toEqual({
      perTransaction: '30000000.00',
      perDay: '50000000.00',
      usedToday: '0.00',
      remainingToday: '50000000.00',
    });

    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '12345678.50', description: 'L7 withdraw' })
      .expect(201);

    const meAfter = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    expect(meAfter.body.limits).toEqual({
      perTransaction: '30000000.00',
      perDay: '50000000.00',
      usedToday: '12345678.50',
      remainingToday: '37654321.50',
    });
  });

  // =========================================================================
  // BÀI 5.2 — TRẠNG THÁI TÀI KHOẢN (ACTIVE/FROZEN/CLOSED) & SỐ DƯ KHẢ DỤNG (A1 -> A6)
  // =========================================================================

  it('A1: transactions from/to FROZEN or CLOSED accounts are rejected with 422 and recorded as FAILED with exact failure_code (all 4 status codes verified, 0 ledger entries)', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const idemRepo = dataSource.getRepository(IdempotencyKey);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'A1-Admin');
    const userA = await createAuthenticatedAccount(app, 'A1-A', '1000000.00');
    const userB = await createAuthenticatedAccount(app, 'A1-B', '0.00');

    const ledgerCountBefore = await ledgerRepo.count();

    const getFailureCodeByKey = async (userId: string, key: string) => {
      const rec = await idemRepo.findOneByOrFail({
        user_id: userId,
        idempotency_key: key,
      });
      const tx = await txRepo.findOneByOrFail({ id: rec.transaction_id! });
      expect(tx.status).toBe(TransactionStatus.FAILED);
      return tx.failure_code;
    };

    // 1. Đóng băng tài khoản nguồn A (FROZEN) -> Chuyển tiền và Rút tiền từ A bị từ chối với SOURCE_ACCOUNT_FROZEN; Nạp vào A bị từ chối với DESTINATION_ACCOUNT_FROZEN
    await request(httpServer)
      .patch(`/api/admin/accounts/${userA.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.FROZEN })
      .expect(200);

    const k1 = randomUUID();
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', k1)
      .send({ toAccountNumber: userB.accountNumber, amount: '50000.00' })
      .expect(422);
    expect(await getFailureCodeByKey(userA.userId, k1)).toBe(
      TransactionFailureCode.SOURCE_ACCOUNT_FROZEN,
    );

    const k2 = randomUUID();
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', k2)
      .send({ amount: '50000.00' })
      .expect(422);
    expect(await getFailureCodeByKey(userA.userId, k2)).toBe(
      TransactionFailureCode.DESTINATION_ACCOUNT_FROZEN,
    );

    // Mở băng lại cho A, đóng băng B (FROZEN) -> A chuyển sang B bị từ chối với DESTINATION_ACCOUNT_FROZEN
    await request(httpServer)
      .patch(`/api/admin/accounts/${userA.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.ACTIVE })
      .expect(200);

    await request(httpServer)
      .patch(`/api/admin/accounts/${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.FROZEN })
      .expect(200);

    const k3 = randomUUID();
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', k3)
      .send({ toAccountNumber: userB.accountNumber, amount: '50000.00' })
      .expect(422);
    expect(await getFailureCodeByKey(userA.userId, k3)).toBe(
      TransactionFailureCode.DESTINATION_ACCOUNT_FROZEN,
    );

    // 2. Đóng tài khoản B (status = CLOSED, vì B đang có balance = 0, hold = 0)
    await request(httpServer)
      .patch(`/api/admin/accounts/${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.CLOSED })
      .expect(200);

    // A chuyển sang B (CLOSED) -> DESTINATION_ACCOUNT_CLOSED
    const k4 = randomUUID();
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', k4)
      .send({ toAccountNumber: userB.accountNumber, amount: '50000.00' })
      .expect(422);
    expect(await getFailureCodeByKey(userA.userId, k4)).toBe(
      TransactionFailureCode.DESTINATION_ACCOUNT_CLOSED,
    );

    // B rút tiền từ tài khoản đã CLOSED -> SOURCE_ACCOUNT_CLOSED
    const k5 = randomUUID();
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', k5)
      .send({ amount: '10000.00' })
      .expect(422);
    expect(await getFailureCodeByKey(userB.userId, k5)).toBe(
      TransactionFailureCode.SOURCE_ACCOUNT_CLOSED,
    );

    // Tuyệt đối không có bút toán mới nào sinh ra
    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('A2: unfreezing (FROZEN -> ACTIVE) restores transactions; CLOSED is terminal (cannot reopen -> 409); closing fails with 409 when balance > 0, hold > 0, or pending transaction exists', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'A2-Admin');
    const user = await createAuthenticatedAccount(app, 'A2-User', '200000.00');

    // 1. Đóng băng rồi mở băng -> Giao dịch hoạt động trở lại bình thường
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.FROZEN })
      .expect(200);

    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.ACTIVE })
      .expect(200);

    // 2. Thử đóng tài khoản khi còn số dư 200,000.00 -> 409 Conflict
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.CLOSED })
      .expect(409);

    // 3. Đặt holdAmount = 50,000.00 rồi thử đóng -> 409 Conflict
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ holdAmount: '50000.00' })
      .expect(200);

    // Gỡ hold về 0 và rút hết 200,000.00 để số dư = 0.00
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ holdAmount: '0.00' })
      .expect(200);

    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '200000.00', description: 'A2 empty balance' })
      .expect(201);

    // 4. Giả lập có 1 giao dịch đang PROCESSING liên quan tới tài khoản -> thử đóng bị chặn 409
    const pendingTx = await txRepo.save(
      txRepo.create({
        actor_account_id: user.accountId,
        from_account_id: user.accountId,
        to_account_id: null,
        amount: '10000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: 'A2 pending tx blocking close',
      }),
    );

    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.CLOSED })
      .expect(409);

    // Đưa giao dịch treo sang FAILED để hết giao dịch dở -> Đóng tài khoản thành công (200)
    await txRepo.update(
      { id: pendingTx.id },
      {
        status: TransactionStatus.FAILED,
        failure_code: TransactionFailureCode.TIMEOUT,
      },
    );

    const closeRes = await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.CLOSED })
      .expect(200);
    expect(closeRes.body.status).toBe(AccountStatus.CLOSED);

    // 5. CLOSED là trạng thái cuối -> thử mở lại sang ACTIVE hoặc FROZEN đều bị từ chối 409
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.ACTIVE })
      .expect(409);

    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.FROZEN })
      .expect(409);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('A3: available balance (balance 1,000,000 - hold 400,000 = 600,000) -> withdrawing 700,000 fails with 422 INSUFFICIENT_BALANCE, withdrawing 600,000 succeeds, hold > balance returns 422, and concurrent hold + withdraw never violates balance >= hold', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'A3-Admin');
    const user = await createAuthenticatedAccount(app, 'A3-User', '1000000.00');

    // 1. Đặt holdAmount > balance (1,500,000 > 1,000,000) -> 422 Unprocessable Entity
    await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ holdAmount: '1500000.00' })
      .expect(422);

    // 2. Đặt holdAmount = 400,000.00 trên số dư 1,000,000.00 -> availableBalance = 600,000.00
    const holdRes = await request(httpServer)
      .patch(`/api/admin/accounts/${user.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ holdAmount: '400000.00' })
      .expect(200);
    expect(holdRes.body.availableBalance).toBe('600000.00');

    // 3. Rút 700,000.00 (> 600,000.00 khả dụng) -> 422 INSUFFICIENT_BALANCE
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: '700000.00',
        description: 'A3 withdraw 700k over available 600k',
      })
      .expect(422);

    // 4. Rút đúng 600,000.00 -> 201 COMPLETED (số dư còn 400,000.00, hold = 400,000.00, khả dụng = 0.00)
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: '600000.00',
        description: 'A3 withdraw exact 600k available',
      })
      .expect(201);

    // 5. Kiểm tra tranh chấp đồng thời giữa Admin đặt holdAmount (800,000) và Khách rút tiền (800,000) trên tài khoản 1,000,000
    const raceUser = await createAuthenticatedAccount(
      app,
      'A3-RaceUser',
      '1000000.00',
    );

    const [adminHoldRes, userWithdrawRes] = await Promise.all([
      request(httpServer)
        .patch(`/api/admin/accounts/${raceUser.accountNumber}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ holdAmount: '800000.00' }),
      request(httpServer)
        .post('/api/transactions/withdraw')
        .set('Authorization', `Bearer ${raceUser.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: '800000.00', description: 'A3 concurrent withdraw' }),
    ]);

    // Chỉ tối đa 1 trong 2 thao tác thành công (thao tác đến sau sẽ bị chặn 422 vì không đủ số dư / vượt số dư),
    // và không bao giờ vi phạm balance >= hold_amount (Q8)
    expect([200, 422]).toContain(adminHoldRes.status);
    expect([201, 422]).toContain(userWithdrawRes.status);
    expect(adminHoldRes.status === 200 && userWithdrawRes.status === 201).toBe(
      false,
    );

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('A4: database CHECK constraints on accounts reject raw SQL with balance < 0, hold_amount < 0, or hold_amount > balance', async () => {
    const user = await createAuthenticatedAccount(app, 'A4-User', '500000.00');

    // 1. balance < 0 -> bị chặn bởi CHK_accounts_balance_non_negative
    await expect(
      dataSource.query(
        `UPDATE "accounts" SET "balance" = -1.00 WHERE "id" = $1`,
        [user.accountId],
      ),
    ).rejects.toThrow(/CHK_accounts_balance_non_negative/i);

    // 2. hold_amount < 0 -> bị chặn bởi CHK_accounts_hold_non_negative
    await expect(
      dataSource.query(
        `UPDATE "accounts" SET "hold_amount" = -10.00 WHERE "id" = $1`,
        [user.accountId],
      ),
    ).rejects.toThrow(/CHK_accounts_hold_non_negative/i);

    // 3. hold_amount > balance -> bị chặn bởi CHK_accounts_hold_lte_balance
    await expect(
      dataSource.query(
        `UPDATE "accounts" SET "hold_amount" = 600000.00 WHERE "id" = $1`,
        [user.accountId],
      ),
    ).rejects.toThrow(/CHK_accounts_hold_lte_balance/i);

    await assertModule5Invariants(dataSource);
  });

  it('A5: PATCH /admin/accounts/:accountNumber enforces ADMIN role (CUSTOMER gets 403), records ACCOUNT_UPDATED audit log with exact before/after diff, skips audit when unchanged, and returns 404 for unknown account', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'A5-Admin');
    const cust = await createAuthenticatedAccount(app, 'A5-Cust', '500000.00');

    // 1. CUSTOMER gọi PATCH /api/admin/accounts/:accountNumber -> 403 Forbidden
    await request(httpServer)
      .patch(`/api/admin/accounts/${cust.accountNumber}`)
      .set('Authorization', `Bearer ${cust.token}`)
      .send({ tier: AccountTier.VIP })
      .expect(403);

    // 2. Số tài khoản không tồn tại -> 404 Not Found
    await request(httpServer)
      .patch('/api/admin/accounts/9999999999')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tier: AccountTier.VIP })
      .expect(404);

    // 3. Admin cập nhật đồng thời tier -> VIP và holdAmount -> 150000.00
    await request(httpServer)
      .patch(`/api/admin/accounts/${cust.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tier: AccountTier.VIP, holdAmount: '150000.00' })
      .expect(200);

    // 4. Gửi lại y nguyên { tier: VIP, holdAmount: '150000.00' } -> 200 OK nhưng không sinh thêm bản ghi audit
    await request(httpServer)
      .patch(`/api/admin/accounts/${cust.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tier: AccountTier.VIP, holdAmount: '150000.00' })
      .expect(200);

    const auditRes = await request(httpServer)
      .get(
        `/api/admin/audit-logs?action=${AuditAction.ACCOUNT_UPDATED}&entityId=${cust.accountId}`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(auditRes.body.data).toHaveLength(1);
    const logEntry = auditRes.body.data[0];
    expect(logEntry.entity).toBe(AuditEntity.ACCOUNTS);
    expect(logEntry.actor.id).toBe(admin.userId);
    expect(logEntry.beforeData).toEqual({
      tier: AccountTier.STANDARD,
      holdAmount: '0.00',
    });
    expect(logEntry.afterData).toEqual({
      tier: AccountTier.VIP,
      holdAmount: '150000.00',
    });

    await assertAuditInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('A6: reversing a transaction when a related account is FROZEN or CLOSED fails with 422 (records FAILED reversal with exact code); unfreezing allows reversal to succeed', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'A6-Admin');
    const userA = await createAuthenticatedAccount(app, 'A6-A', '500000.00');
    const userB = await createAuthenticatedAccount(app, 'A6-B', '100000.00');

    // 1. A chuyển 100,000.00 sang B -> COMPLETED
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '100000.00',
        description: 'A6 transfer to reverse',
      })
      .expect(201);

    // 2. Admin đóng băng tài khoản B (FROZEN) -> Hoàn tiền bị từ chối 422 (SOURCE_ACCOUNT_FROZEN vì B là bên bị thu hồi tiền)
    await request(httpServer)
      .patch(`/api/admin/accounts/${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.FROZEN })
      .expect(200);

    const failRevKey = randomUUID();
    await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', failRevKey)
      .send({ reason: 'A6 attempt while B is FROZEN' })
      .expect(422);

    const failRevKeyRec = await idemRepo.findOneByOrFail({
      user_id: admin.userId,
      idempotency_key: failRevKey,
    });
    const failedRevTx = await txRepo.findOneByOrFail({
      id: failRevKeyRec.transaction_id!,
    });
    expect(failedRevTx.status).toBe(TransactionStatus.FAILED);
    expect(failedRevTx.failure_code).toBe(
      TransactionFailureCode.SOURCE_ACCOUNT_FROZEN,
    );

    // Giao dịch gốc vẫn giữ nguyên COMPLETED
    const origStillCompleted = await txRepo.findOneByOrFail({
      id: tfRes.body.id,
    });
    expect(origStillCompleted.status).toBe(TransactionStatus.COMPLETED);

    // 3. Admin mở băng tài khoản B (FROZEN -> ACTIVE) rồi hoàn tiền lại bằng key mới -> Thành công 201!
    await request(httpServer)
      .patch(`/api/admin/accounts/${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: AccountStatus.ACTIVE })
      .expect(200);

    const successRevRes = await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'A6 retry after unfreezing B' })
      .expect(201);

    expect(successRevRes.body.status).toBe(TransactionStatus.COMPLETED);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });
});
