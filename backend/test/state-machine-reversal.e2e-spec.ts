import { ConflictException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/database/entities/transaction.entity';
import {
  LedgerEntry,
  LedgerEntryType,
} from '../src/database/entities/ledger-entry.entity';
import {
  canTransition,
  TransactionFailureCode,
} from '../src/transactions/transactions.constants';
import { TransactionsService } from '../src/transactions/transactions.service';
import {
  assertLedgerInvariants,
  createAuthenticatedAccount,
  createAuthenticatedAdmin,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

jest.setTimeout(60000);

describe('Module 3B (3.2 & 5.3) — State Machine, Stuck Sweep & Reversal (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let transactionsService: TransactionsService;

  beforeAll(async () => {
    const setup = await createTestApp();
    app = setup.app;
    dataSource = setup.dataSource;
    transactionsService = app.get(TransactionsService);
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
  // ST & ST2 — KIỂM THỬ BẢNG CHUYỂN TRẠNG THÁI (STATE MACHINE)
  // =========================================================================

  it('ST: verifies all 36 (from, to) status transition pairs -> only the 7 valid edges are allowed, all 29 other pairs are rejected', () => {
    const allStatuses: TransactionStatus[] = [
      TransactionStatus.INITIATED,
      TransactionStatus.PENDING_OTP,
      TransactionStatus.PROCESSING,
      TransactionStatus.COMPLETED,
      TransactionStatus.FAILED,
      TransactionStatus.REVERSED,
    ];

    const expectedValidEdges = new Set<string>([
      `${TransactionStatus.INITIATED}->${TransactionStatus.PENDING_OTP}`,
      `${TransactionStatus.INITIATED}->${TransactionStatus.PROCESSING}`,
      `${TransactionStatus.PENDING_OTP}->${TransactionStatus.PROCESSING}`,
      `${TransactionStatus.PENDING_OTP}->${TransactionStatus.FAILED}`,
      `${TransactionStatus.PROCESSING}->${TransactionStatus.COMPLETED}`,
      `${TransactionStatus.PROCESSING}->${TransactionStatus.FAILED}`,
      `${TransactionStatus.COMPLETED}->${TransactionStatus.REVERSED}`,
    ]);

    let checkedCount = 0;
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        checkedCount += 1;
        const edgeKey = `${from}->${to}`;
        const expected = expectedValidEdges.has(edgeKey);
        expect(canTransition(from, to)).toBe(expected);
      }
    }

    expect(checkedCount).toBe(36);
    // Kiểm tra tường minh các cạnh cấm tiêu biểu theo đề bài
    expect(
      canTransition(TransactionStatus.FAILED, TransactionStatus.COMPLETED),
    ).toBe(false);
    expect(
      canTransition(TransactionStatus.COMPLETED, TransactionStatus.PROCESSING),
    ).toBe(false);
    expect(
      canTransition(TransactionStatus.REVERSED, TransactionStatus.COMPLETED),
    ).toBe(false);
  });

  it('ST2: service transition() rejects invalid state transition FAILED -> COMPLETED and keeps DB status unchanged', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const user = await createAuthenticatedAccount(app, 'ST2-User', '100000.00');

    // Tạo 1 giao dịch FAILED bằng cách rút quá số dư
    const failKey = randomUUID();
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', failKey)
      .send({ amount: '500000.00', description: 'ST2 failed withdraw' })
      .expect(422);

    const failedTx = await txRepo.findOneByOrFail({
      idempotency_key: failKey,
    });
    expect(failedTx.status).toBe(TransactionStatus.FAILED);

    // Thử ép chuyển từ FAILED -> COMPLETED qua hàm transition() của service -> Phải bị từ chối!
    await expect(
      transactionsService.transition(
        dataSource.manager,
        failedTx.id,
        TransactionStatus.FAILED,
        TransactionStatus.COMPLETED,
      ),
    ).rejects.toThrow(ConflictException);

    const txAfter = await txRepo.findOneByOrFail({ id: failedTx.id });
    expect(txAfter.status).toBe(TransactionStatus.FAILED);

    await assertLedgerInvariants(dataSource);
  });

  // =========================================================================
  // F1 & F2 — GHI NHẬN GIAO DỊCH FAILED & REPLAY LỖI CŨ
  // =========================================================================

  it('F1: withdrawing 1,000,000 on 100,000 balance records 1 FAILED transaction (INSUFFICIENT_BALANCE) with 0 ledger entries, and replaying same key returns same 422', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);

    const user = await createAuthenticatedAccount(app, 'F1-User', '100000.00');
    const ledgerCountBefore = await ledgerRepo.count();

    const idempotencyKey = randomUUID();
    const payload = {
      amount: '1000000.00',
      description: 'F1 withdraw over balance',
    };

    // 1. Lần gửi đầu tiên -> 422
    const res1 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(422);

    expect(res1.body.message).toBe('Không đủ số dư khả dụng');

    // 2. Có đúng 1 giao dịch FAILED với failure_code = INSUFFICIENT_BALANCE, 0 bút toán mới
    const failedTxs = await txRepo.find({
      where: { idempotency_key: idempotencyKey },
    });
    expect(failedTxs).toHaveLength(1);
    expect(failedTxs[0].status).toBe(TransactionStatus.FAILED);
    expect(failedTxs[0].failure_code).toBe(
      TransactionFailureCode.INSUFFICIENT_BALANCE,
    );

    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    // 3. Gửi lại (Replay) cùng key -> trả về cùng 422 mà không tạo thêm bản ghi thứ hai
    const res2 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(422);

    expect(res2.body.message).toBe('Không đủ số dư khả dụng');
    expect(
      await txRepo.count({ where: { idempotency_key: idempotencyKey } }),
    ).toBe(1);

    // 4. Số dư vẫn giữ nguyên 100,000.00 và lịch sử có hiển thị dòng FAILED
    const meRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(meRes.body.balance).toBe('100000.00');

    const historyRes = await request(httpServer)
      .get('/api/transactions?page=1&limit=10')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const failedInHistory = historyRes.body.data.find(
      (item: any) => item.id === failedTxs[0].id,
    );
    expect(failedInHistory).toBeDefined();
    expect(failedInHistory.status).toBe(TransactionStatus.FAILED);
    expect(failedInHistory.failure_code).toBeUndefined();

    await assertLedgerInvariants(dataSource);
  });

  it('F2: unexpected error in Phase B returns generic 500, records FAILED (INTERNAL_ERROR), and leaves balances and ledger unchanged', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);

    const sender = await createAuthenticatedAccount(
      app,
      'F2-Sender',
      '500000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'F2-Receiver',
      '100000.00',
    );
    const ledgerCountBefore = await ledgerRepo.count();

    jest
      .spyOn(transactionsService as any, 'creditAccount')
      .mockRejectedValueOnce(new Error('Simulated unexpected Phase B crash'));

    const failKey = randomUUID();
    const res = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', failKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '200000.00',
        description: 'F2 unexpected crash test',
      })
      .expect(500);

    expect(res.body.message).toBe('Lỗi hệ thống khi thực hiện giao dịch');

    const failedTx = await txRepo.findOneByOrFail({
      idempotency_key: failKey,
    });
    expect(failedTx.status).toBe(TransactionStatus.FAILED);
    expect(failedTx.failure_code).toBe(TransactionFailureCode.INTERNAL_ERROR);

    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    expect(meSender.body.balance).toBe('500000.00');

    await assertLedgerInvariants(dataSource);
  });

  // =========================================================================
  // P1 & P2 — REPLAY GIAO DỊCH ĐANG XỬ LÝ (202) & QUÉT GIAO DỊCH TREO
  // =========================================================================

  it('P1: replaying a request with same Idempotency-Key and payload while transaction is PROCESSING returns 202 Accepted and leaves balance unchanged', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const sender = await createAuthenticatedAccount(
      app,
      'P1-Sender',
      '500000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'P1-Receiver',
      '100000.00',
    );

    const processingKey = randomUUID();
    const inFlightTx = await txRepo.save(
      txRepo.create({
        actor_account_id: sender.accountId,
        from_account_id: sender.accountId,
        to_account_id: receiver.accountId,
        amount: '150000.00',
        type: TransactionType.TRANSFER,
        status: TransactionStatus.PROCESSING,
        description: 'P1 in-flight transfer',
        idempotency_key: processingKey,
      }),
    );

    // Gửi lại cùng key và cùng payload khi phiếu đang PROCESSING -> 202 Accepted
    const replayRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', processingKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '150000.00',
        description: 'P1 in-flight transfer',
      })
      .expect(202);

    expect(replayRes.body.id).toBe(inFlightTx.id);
    expect(replayRes.body.status).toBe(TransactionStatus.PROCESSING);

    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    expect(meSender.body.balance).toBe('500000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('P2: sweepStuckTransactions() marks old PROCESSING without ledger entries as FAILED/TIMEOUT, keeps fresh PROCESSING untouched, and logs error without modifying old PROCESSING that has ledger entries', async () => {
    const txRepo = dataSource.getRepository(Transaction);
    const user = await createAuthenticatedAccount(app, 'P2-User', '500000.00');

    const oldDate = new Date(Date.now() - 300 * 1000); // 5 phút trước (> 120s)
    const freshDate = new Date(); // Vừa mới tạo

    // 1. Phiếu PROCESSING cũ KHÔNG có bút toán -> Phải được chuyển sang FAILED / TIMEOUT
    const stuckNoLedger = await txRepo.save(
      txRepo.create({
        actor_account_id: user.accountId,
        from_account_id: user.accountId,
        to_account_id: null,
        amount: '50000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: 'P2 old stuck without ledger',
        idempotency_key: randomUUID(),
        created_at: oldDate,
      }),
    );
    await dataSource.query(
      `UPDATE "transactions" SET "updated_at" = $1 WHERE "id" = $2`,
      [oldDate, stuckNoLedger.id],
    );

    // 2. Phiếu PROCESSING mới tinh -> Phải giữ nguyên PROCESSING
    const freshProcessing = await txRepo.save(
      txRepo.create({
        actor_account_id: user.accountId,
        from_account_id: user.accountId,
        to_account_id: null,
        amount: '60000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: 'P2 fresh processing',
        idempotency_key: randomUUID(),
        created_at: freshDate,
      }),
    );

    // 3. Phiếu PROCESSING cũ NHƯNG ĐÃ CÓ bút toán (giả lập sự cố dị thường) -> Phải giữ nguyên và log error
    const anomalyTx = await txRepo.save(
      txRepo.create({
        actor_account_id: user.accountId,
        from_account_id: user.accountId,
        to_account_id: null,
        amount: '70000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: 'P2 anomaly old processing with ledger entry',
        idempotency_key: randomUUID(),
        created_at: oldDate,
      }),
    );
    await dataSource.query(
      `UPDATE "transactions" SET "updated_at" = $1 WHERE "id" = $2`,
      [oldDate, anomalyTx.id],
    );
    await dataSource.getRepository(LedgerEntry).insert({
      account_id: user.accountId,
      transaction_id: anomalyTx.id,
      type: LedgerEntryType.DEBIT,
      amount: '70000.00',
      balance_after: '430000.00',
    });

    const loggerErrorSpy = jest.spyOn(
      (transactionsService as any).logger,
      'error',
    );

    const sweepResult = await transactionsService.sweepStuckTransactions();

    expect(sweepResult.sweptCount).toBe(1);
    expect(sweepResult.sweptIds).toEqual([stuckNoLedger.id]);
    expect(sweepResult.skippedWithLedgerCount).toBe(1);
    expect(loggerErrorSpy).toHaveBeenCalled();

    const stuckAfter = await txRepo.findOneByOrFail({ id: stuckNoLedger.id });
    expect(stuckAfter.status).toBe(TransactionStatus.FAILED);
    expect(stuckAfter.failure_code).toBe(TransactionFailureCode.TIMEOUT);

    const freshAfter = await txRepo.findOneByOrFail({ id: freshProcessing.id });
    expect(freshAfter.status).toBe(TransactionStatus.PROCESSING);

    const anomalyAfter = await txRepo.findOneByOrFail({ id: anomalyTx.id });
    expect(anomalyAfter.status).toBe(TransactionStatus.PROCESSING);
  });

  // =========================================================================
  // V1 -> V4 — KIỂM THỬ HOÀN TIỀN (REVERSAL) & PHÂN QUYỀN ADMIN
  // =========================================================================

  it('V1: reverses COMPLETED transfer, deposit, and withdraw transactions -> marks original REVERSED with reversalTransactionId, creates REVERSAL with inverse ledger entries, restores balances, and passes Q1-Q5', async () => {
    const httpServer = app.getHttpServer();
    const ledgerRepo = dataSource.getRepository(LedgerEntry);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'V1-Admin');
    const userA = await createAuthenticatedAccount(app, 'V1-A', '1000000.00');
    const userB = await createAuthenticatedAccount(app, 'V1-B', '500000.00');

    // --- Kịch bản 1: Hoàn tiền cho TRANSFER (A chuyển 100,000 cho B) ---
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '100000.00',
        description: 'V1 transfer A->B',
      })
      .expect(201);

    const revTfRes = await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Reverse V1 transfer' })
      .expect(201);

    expect(revTfRes.body.type).toBe(TransactionType.REVERSAL);
    expect(revTfRes.body.status).toBe(TransactionStatus.COMPLETED);
    expect(revTfRes.body.originalTransactionId).toBe(tfRes.body.id);
    expect(revTfRes.body.amount).toBe('100000.00');

    // Bút toán của giao dịch gốc không đổi (vẫn 2), và có thêm 2 bút toán đảo của REVERSAL
    expect(
      await ledgerRepo.count({ where: { transaction_id: tfRes.body.id } }),
    ).toBe(2);
    expect(
      await ledgerRepo.count({ where: { transaction_id: revTfRes.body.id } }),
    ).toBe(2);

    // Số dư của A và B quay trở về đúng như trước khi chuyển (1,000,000 và 500,000)
    const meAAfterTfRev = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    const meBAfterTfRev = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);
    expect(meAAfterTfRev.body.balance).toBe('1000000.00');
    expect(meBAfterTfRev.body.balance).toBe('500000.00');

    // Lịch sử của User A hiển thị giao dịch gốc ở trạng thái REVERSED kèm reversalTransactionId
    const historyA = await request(httpServer)
      .get('/api/transactions?page=1&limit=10')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    const origInHistory = historyA.body.data.find(
      (t: any) => t.id === tfRes.body.id,
    );
    expect(origInHistory.status).toBe(TransactionStatus.REVERSED);
    expect(origInHistory.reversalTransactionId).toBe(revTfRes.body.id);

    // --- Kịch bản 2: Hoàn tiền cho DEPOSIT (A nạp 200,000 rồi hoàn tiền) ---
    const depRes = await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '200000.00', description: 'V1 deposit A' })
      .expect(201);

    const revDepRes = await request(httpServer)
      .post(`/api/transactions/${depRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Reverse V1 deposit' })
      .expect(201);

    expect(revDepRes.body.originalTransactionId).toBe(depRes.body.id);

    // --- Kịch bản 3: Hoàn tiền cho WITHDRAW (A rút 150,000 rồi hoàn tiền) ---
    const witRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '150000.00', description: 'V1 withdraw A' })
      .expect(201);

    const revWitRes = await request(httpServer)
      .post(`/api/transactions/${witRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Reverse V1 withdraw' })
      .expect(201);

    expect(revWitRes.body.originalTransactionId).toBe(witRes.body.id);

    const finalMeA = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    expect(finalMeA.body.balance).toBe('1000000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('V2: prevents double reversal -> 5 concurrent reversal requests with 5 different keys result in exactly 1 success (201) and 4 conflicts (409); replaying winning key returns 200', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'V2-Admin');
    const userA = await createAuthenticatedAccount(app, 'V2-A', '1000000.00');
    const userB = await createAuthenticatedAccount(app, 'V2-B', '500000.00');

    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '200000.00',
        description: 'V2 transfer to reverse concurrently',
      })
      .expect(201);

    const origTxId = tfRes.body.id as string;

    // Bắn đồng thời 5 request hoàn tiền với 5 Idempotency-Key khác nhau
    const keys = Array.from({ length: 5 }, () => randomUUID());
    const tasks = keys.map((key) =>
      request(httpServer)
        .post(`/api/transactions/${origTxId}/reverse`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('Idempotency-Key', key)
        .send({ reason: 'Concurrent reversal' })
        .then((res) => ({ key, status: res.status, body: res.body })),
    );

    const results = await Promise.all(tasks);

    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    const winningResult = successes[0];

    // Gửi lại lần nữa bằng một key mới -> 409 Conflict
    await request(httpServer)
      .post(`/api/transactions/${origTxId}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Second attempt after already reversed' })
      .expect(409);

    // Gửi lại (Replay) bằng đúng key đã thắng -> 200 OK kèm đúng giao dịch hoàn tiền cũ
    const replayRes = await request(httpServer)
      .post(`/api/transactions/${origTxId}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', winningResult.key)
      .send({ reason: 'Concurrent reversal' })
      .expect(200);

    expect(replayRes.body.id).toBe(winningResult.body.id);

    // Trong DB chỉ có đúng 1 bản ghi REVERSAL ở trạng thái COMPLETED cho giao dịch gốc này
    const completedReversals = await txRepo.count({
      where: {
        original_transaction_id: origTxId,
        type: TransactionType.REVERSAL,
        status: TransactionStatus.COMPLETED,
      },
    });
    expect(completedReversals).toBe(1);

    await assertLedgerInvariants(dataSource);
  });

  it('V3: when receiver has spent the funds, reversal fails with 422 (REVERSAL_INSUFFICIENT_BALANCE), original stays COMPLETED, and reversal succeeds later once receiver deposits funds', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'V3-Admin');
    const userA = await createAuthenticatedAccount(app, 'V3-A', '500000.00');
    const userB = await createAuthenticatedAccount(app, 'V3-B', '0.00');

    // 1. A chuyển 300,000 cho B -> B có 300,000
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '300000.00',
        description: 'V3 transfer A->B',
      })
      .expect(201);

    // 2. B rút tiêu mất 250,000 -> B chỉ còn 50,000 (< 300,000)
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '250000.00', description: 'V3 B spends money' })
      .expect(201);

    // 3. Admin thử hoàn tiền giao dịch 300,000 -> 422 REVERSAL_INSUFFICIENT_BALANCE
    const firstRevKey = randomUUID();
    await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', firstRevKey)
      .send({ reason: 'First reversal when B is broke' })
      .expect(422);

    // Giao dịch gốc vẫn giữ nguyên COMPLETED, còn phiếu REVERSAL lần 1 mang trạng thái FAILED
    const origAfterFail = await txRepo.findOneByOrFail({ id: tfRes.body.id });
    expect(origAfterFail.status).toBe(TransactionStatus.COMPLETED);

    const failedRev = await txRepo.findOneByOrFail({
      idempotency_key: firstRevKey,
    });
    expect(failedRev.status).toBe(TransactionStatus.FAILED);
    expect(failedRev.failure_code).toBe(
      TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE,
    );

    // 4. B nạp thêm 300,000 vào tài khoản -> B có 350,000 (đủ tiền hoàn trả)
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '300000.00', description: 'V3 B tops up' })
      .expect(201);

    // 5. Admin thực hiện hoàn tiền lại với Idempotency-Key mới -> Thành công 201!
    const secondRevRes = await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Second reversal after B topped up' })
      .expect(201);

    expect(secondRevRes.body.status).toBe(TransactionStatus.COMPLETED);

    const origAfterSuccess = await txRepo.findOneByOrFail({
      id: tfRes.body.id,
    });
    expect(origAfterSuccess.status).toBe(TransactionStatus.REVERSED);

    await assertLedgerInvariants(dataSource);
  });

  it('V4: enforces RBAC (customer gets 403) and rejects reversing FAILED, already REVERSED, or REVERSAL transactions with 409', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'V4-Admin');
    const userA = await createAuthenticatedAccount(app, 'V4-A', '500000.00');
    const userB = await createAuthenticatedAccount(app, 'V4-B', '100000.00');

    // Tạo 1 giao dịch COMPLETED
    const completedRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '100000.00',
        description: 'V4 completed transfer',
      })
      .expect(201);

    // 1. Khách hàng (customer) gọi hoàn tiền -> 403 Forbidden
    await request(httpServer)
      .post(`/api/transactions/${completedRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Customer unauthorized attempt' })
      .expect(403);

    // 2. Tạo 1 giao dịch FAILED rồi Admin thử hoàn tiền -> 409 Conflict
    const failedKey = randomUUID();
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', failedKey)
      .send({ amount: '9999999.00', description: 'V4 failed withdraw' })
      .expect(422);

    const failedTx = await dataSource
      .getRepository(Transaction)
      .findOneByOrFail({ idempotency_key: failedKey });

    await request(httpServer)
      .post(`/api/transactions/${failedTx.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Try reversing FAILED tx' })
      .expect(409);

    // 3. Admin hoàn tiền giao dịch COMPLETED thành công -> tạo ra giao dịch REVERSAL
    const reversalRes = await request(httpServer)
      .post(`/api/transactions/${completedRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Valid reversal' })
      .expect(201);

    // 4. Admin thử hoàn tiền lại giao dịch đã REVERSED -> 409 Conflict
    await request(httpServer)
      .post(`/api/transactions/${completedRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Try reversing already REVERSED tx' })
      .expect(409);

    // 5. Admin thử hoàn tiền chính giao dịch REVERSAL -> 409 Conflict
    await request(httpServer)
      .post(`/api/transactions/${reversalRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Try reversing a REVERSAL tx' })
      .expect(409);

    await assertLedgerInvariants(dataSource);
  });
});
