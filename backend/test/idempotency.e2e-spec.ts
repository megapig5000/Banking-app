import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/database/entities/transaction.entity';
import { LedgerEntry } from '../src/database/entities/ledger-entry.entity';
import {
  IdempotencyKey,
  IdempotencyKeyStatus,
} from '../src/database/entities/idempotency-key.entity';
import { IdempotencyService } from '../src/idempotency/idempotency.service';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionFailureCode } from '../src/transactions/transactions.constants';
import {
  assertLedgerInvariants,
  createAuthenticatedAccount,
  createAuthenticatedAdmin,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

jest.setTimeout(60000);

describe('Module 2 (2.1) — Idempotency Keys Table, Snapshot Replay, TTL & Cleanup (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let idempotencyService: IdempotencyService;
  let transactionsService: TransactionsService;

  beforeAll(async () => {
    const setup = await createTestApp();
    app = setup.app;
    dataSource = setup.dataSource;
    idempotencyService = app.get(IdempotencyService);
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

  it('I1: 5 sequential requests with the same Idempotency-Key and payload -> 1st returns 201, next 4 return 200 with identical response body, only 1 transaction and 2 ledger entries created', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'I1-Sender',
      '500000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'I1-Receiver',
      '100000.00',
    );

    const txCountBefore = await txRepo.count();
    const ledgerCountBefore = await ledgerRepo.count();

    const sharedKey = randomUUID();
    const statuses: number[] = [];
    const bodies: any[] = [];

    for (let i = 0; i < 5; i++) {
      // Lần thứ 2 thử gửi "100000" (không có .00) để kiểm chứng chuẩn hóa số thập phân bằng chuỗi
      const amountVariant = i === 1 ? '100000' : '100000.00';
      const res = await request(httpServer)
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${sender.token}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          toAccountNumber: receiver.accountNumber,
          amount: amountVariant,
          description: 'I1 sequential idempotent transfer',
        });

      statuses.push(res.status);
      bodies.push(res.body);
    }

    expect(statuses).toEqual([201, 200, 200, 200, 200]);

    // Cả 5 response body phải giống hệt nhau từng trường
    for (let i = 1; i < 5; i++) {
      expect(bodies[i]).toEqual(bodies[0]);
    }

    // Chỉ có đúng 1 giao dịch mới và 2 bút toán mới được tạo
    expect(await txRepo.count()).toBe(txCountBefore + 1);
    expect(await ledgerRepo.count()).toBe(ledgerCountBefore + 2);

    // Dòng khóa trong bảng idempotency_keys ở trạng thái COMPLETED kèm response_status = 201
    const keyRecord = await idemRepo.findOneByOrFail({
      user_id: sender.userId,
      idempotency_key: sharedKey,
    });
    expect(keyRecord.status).toBe(IdempotencyKeyStatus.COMPLETED);
    expect(keyRecord.response_status).toBe(201);
    expect(keyRecord.response_body).toEqual(bodies[0]);
    expect(keyRecord.transaction_id).toBe(bodies[0].id);

    // Số dư chỉ thay đổi đúng 1 lần
    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    const meReceiver = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${receiver.token}`)
      .expect(200);

    expect(meSender.body.balance).toBe('400000.00');
    expect(meReceiver.body.balance).toBe('200000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('I2: same Idempotency-Key with different payload (different amount, different recipient, or different operation type) -> returns 409 Conflict and creates no extra transaction', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const sender = await createAuthenticatedAccount(
      app,
      'I2-Sender',
      '500000.00',
    );
    const receiver1 = await createAuthenticatedAccount(
      app,
      'I2-Receiver1',
      '0.00',
    );
    const receiver2 = await createAuthenticatedAccount(
      app,
      'I2-Receiver2',
      '0.00',
    );

    const sharedKey = randomUUID();

    // Giao dịch gốc hợp lệ -> 201
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({
        toAccountNumber: receiver1.accountNumber,
        amount: '100000.00',
        description: 'I2 original transfer',
      })
      .expect(201);

    const txCountAfterFirst = await txRepo.count();

    // (a) Cùng khóa nhưng khác amount -> 409 Conflict
    const diffAmountRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({
        toAccountNumber: receiver1.accountNumber,
        amount: '200000.00',
        description: 'I2 original transfer',
      })
      .expect(409);
    expect(diffAmountRes.body.message).toMatch(/Idempotency-Key/i);

    // (b) Cùng khóa nhưng khác người nhận (toAccountNumber) -> 409 Conflict
    const diffRecipientRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({
        toAccountNumber: receiver2.accountNumber,
        amount: '100000.00',
        description: 'I2 original transfer',
      })
      .expect(409);
    expect(diffRecipientRes.body.message).toMatch(/Idempotency-Key/i);

    // (c) Cùng khóa nhưng dùng cho loại thao tác khác (deposit và withdraw) -> 409 Conflict
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({
        amount: '100000.00',
        description: 'I2 original transfer',
      })
      .expect(409);

    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send({
        amount: '100000.00',
        description: 'I2 original transfer',
      })
      .expect(409);

    // Tuyệt đối không có giao dịch mới nào được tạo thêm
    expect(await txRepo.count()).toBe(txCountAfterFirst);
    await assertLedgerInvariants(dataSource);
  });

  it('I3: 5 concurrent requests with the same Idempotency-Key and payload -> all responses in {201, 200, 202} with exactly one 201, subsequent replay returns 200 with identical body, balance changed once', async () => {
    const httpServer = app.getHttpServer();
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'I3-Sender',
      '500000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'I3-Receiver',
      '0.00',
    );

    const sharedKey = randomUUID();
    const payload = {
      toAccountNumber: receiver.accountNumber,
      amount: '300000.00',
      description: 'I3 concurrent same key',
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(httpServer)
          .post('/api/transactions/transfer')
          .set('Authorization', `Bearer ${sender.token}`)
          .set('Idempotency-Key', sharedKey)
          .send(payload),
      ),
    );

    for (const res of responses) {
      expect([200, 201, 202]).toContain(res.status);
    }

    const createdResponses = responses.filter((r) => r.status === 201);
    expect(createdResponses).toHaveLength(1);

    const winningBody = createdResponses[0].body;

    // Gửi lại lần thứ 6 sau khi cả 5 request đã xong -> phải nhận 200 OK kèm đúng bản chụp của lần 201
    const replayRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', sharedKey)
      .send(payload)
      .expect(200);

    expect(replayRes.body).toEqual(winningBody);

    const keyRecords = await idemRepo.find({
      where: { user_id: sender.userId, idempotency_key: sharedKey },
    });
    expect(keyRecords).toHaveLength(1);
    expect(keyRecords[0].status).toBe(IdempotencyKeyStatus.COMPLETED);

    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    expect(meSender.body.balance).toBe('200000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('I4: replaying a FAILED transaction returns the exact saved 422 error snapshot without re-executing even after account is topped up; using a new key succeeds', async () => {
    const httpServer = app.getHttpServer();
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const user = await createAuthenticatedAccount(app, 'I4-User', '100000.00');

    const failKey = randomUUID();
    const withdrawPayload = {
      amount: '500000.00',
      description: 'I4 withdraw over balance',
    };

    // 1. Rút 500,000 khi chỉ có 100,000 -> 422 FAILED
    const res1 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', failKey)
      .send(withdrawPayload)
      .expect(422);

    const keyRecord = await idemRepo.findOneByOrFail({
      user_id: user.userId,
      idempotency_key: failKey,
    });
    expect(keyRecord.status).toBe(IdempotencyKeyStatus.FAILED);
    expect(keyRecord.response_status).toBe(422);

    // 2. Nạp thêm 1,000,000 vào tài khoản -> Số dư hiện có 1,100,000 (đủ tiền rút 500,000)
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '1000000.00', description: 'I4 top up' })
      .expect(201);

    // 3. Gửi lại CÙNG khóa failKey -> vẫn trả về đúng bản chụp lỗi 422 cũ, KHÔNG chạy lại và không trừ tiền!
    const res2 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', failKey)
      .send(withdrawPayload)
      .expect(422);

    expect(res2.body).toEqual(res1.body);

    const meAfterReplay = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(meAfterReplay.body.balance).toBe('1100000.00');

    // 4. Gửi lại cùng nội dung nhưng với Idempotency-Key MỚI -> Thành công 201, số dư còn 600,000
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send(withdrawPayload)
      .expect(201);

    const meAfterNewKey = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(meAfterNewKey.body.balance).toBe('600000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('I5: expired Idempotency-Key (expired_at in the past) is treated as a brand-new request and creates a new transaction', async () => {
    const httpServer = app.getHttpServer();

    const user = await createAuthenticatedAccount(app, 'I5-User', '500000.00');
    const key = randomUUID();
    const payload = {
      amount: '50000.00',
      description: 'I5 expiring key test',
    };

    // 1. Lần gửi đầu tiên -> 201 Created
    const firstRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    // 2. Đặt expired_at về quá khứ bằng SQL (mô phỏng đã qua 24 giờ)
    await dataSource.query(
      `UPDATE "idempotency_keys" SET "expired_at" = NOW() - INTERVAL '2 hours' WHERE "user_id" = $1 AND "idempotency_key" = $2`,
      [user.userId, key],
    );

    // 3. Gửi lại cùng key sau khi đã hết hạn -> được xử lý như yêu cầu MỚI (201 Created, ID giao dịch mới)
    const secondRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    expect(secondRes.body.id).not.toBe(firstRes.body.id);

    // Số dư đã bị trừ 2 lần (500,000 - 50,000 - 50,000 = 400,000)
    const meRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(meRes.body.balance).toBe('400000.00');

    await assertLedgerInvariants(dataSource);
  });

  it('I6: missing or invalid (non-UUID) Idempotency-Key header returns 400 Bad Request and creates no transaction', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const user = await createAuthenticatedAccount(app, 'I6-User', '200000.00');
    const txCountBefore = await txRepo.count();
    const idemCountBefore = await idemRepo.count();

    // 1. Thiếu header Idempotency-Key -> 400
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount: '50000.00', description: 'Missing header' })
      .expect(400);

    // 2. Header không đúng định dạng UUID -> 400
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', 'not-a-valid-uuid-string')
      .send({ amount: '50000.00', description: 'Invalid UUID header' })
      .expect(400);

    expect(await txRepo.count()).toBe(txCountBefore);
    expect(await idemRepo.count()).toBe(idemCountBefore);
  });

  it('I7: deleteExpiredKeys() deletes expired COMPLETED/FAILED keys while preserving unexpired keys and IN_PROGRESS keys', async () => {
    const idemRepo = dataSource.getRepository(IdempotencyKey);
    const user = await createAuthenticatedAccount(app, 'I7-User', '100000.00');

    // Xóa các khóa khởi tạo trước đó để đếm chính xác 4 khóa mẫu
    await dataSource.query(`DELETE FROM "idempotency_keys"`);

    const pastDate = new Date(Date.now() - 3600 * 1000);
    const futureDate = new Date(Date.now() + 3600 * 1000);

    // 1. Khóa COMPLETED đã hết hạn -> Phải bị xóa
    const expiredCompleted = await idemRepo.save(
      idemRepo.create({
        user_id: user.userId,
        idempotency_key: randomUUID(),
        request_hash: 'a'.repeat(64),
        status: IdempotencyKeyStatus.COMPLETED,
        response_status: 201,
        response_body: { ok: true },
        expired_at: pastDate,
      }),
    );

    // 2. Khóa FAILED đã hết hạn -> Phải bị xóa
    const expiredFailed = await idemRepo.save(
      idemRepo.create({
        user_id: user.userId,
        idempotency_key: randomUUID(),
        request_hash: 'b'.repeat(64),
        status: IdempotencyKeyStatus.FAILED,
        response_status: 422,
        response_body: { message: 'Failed' },
        expired_at: pastDate,
      }),
    );

    // 3. Khóa COMPLETED còn hạn -> Phải được giữ lại
    const activeCompleted = await idemRepo.save(
      idemRepo.create({
        user_id: user.userId,
        idempotency_key: randomUUID(),
        request_hash: 'c'.repeat(64),
        status: IdempotencyKeyStatus.COMPLETED,
        response_status: 201,
        response_body: { ok: true },
        expired_at: futureDate,
      }),
    );

    // 4. Khóa IN_PROGRESS dù đã quá expired_at -> Phải được giữ lại (không xóa khóa đang xử lý)
    const expiredInProgress = await idemRepo.save(
      idemRepo.create({
        user_id: user.userId,
        idempotency_key: randomUUID(),
        request_hash: 'd'.repeat(64),
        status: IdempotencyKeyStatus.IN_PROGRESS,
        response_status: null,
        response_body: null,
        expired_at: pastDate,
      }),
    );

    const deletedCount = await idempotencyService.deleteExpiredKeys();
    expect(deletedCount).toBe(2);

    const remainingKeys = await idemRepo.find();
    const remainingIds = new Set(remainingKeys.map((k) => k.id));

    expect(remainingIds.has(expiredCompleted.id)).toBe(false);
    expect(remainingIds.has(expiredFailed.id)).toBe(false);
    expect(remainingIds.has(activeCompleted.id)).toBe(true);
    expect(remainingIds.has(expiredInProgress.id)).toBe(true);
  });

  it('I8: per-user key isolation -> two different users using the exact same UUID Idempotency-Key create independent transactions and never see each other responses', async () => {
    const httpServer = app.getHttpServer();

    const userA = await createAuthenticatedAccount(app, 'I8-A', '500000.00');
    const userB = await createAuthenticatedAccount(app, 'I8-B', '500000.00');

    const sharedUuid = randomUUID();

    // User A nạp 100,000 với sharedUuid -> 201 Created
    const resA1 = await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', sharedUuid)
      .send({ amount: '100000.00', description: 'User A deposit' })
      .expect(201);

    // User B rút 200,000 với CÙNG sharedUuid -> 201 Created (không bị 409 và không nhận response của User A!)
    const resB1 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', sharedUuid)
      .send({ amount: '200000.00', description: 'User B withdraw' })
      .expect(201);

    expect(resA1.body.id).not.toBe(resB1.body.id);
    expect(resA1.body.type).toBe(TransactionType.DEPOSIT);
    expect(resB1.body.type).toBe(TransactionType.WITHDRAW);

    // Replay của User A trả đúng bản chụp của A; Replay của User B trả đúng bản chụp của B
    const resA2 = await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', sharedUuid)
      .send({ amount: '100000.00', description: 'User A deposit' })
      .expect(200);

    const resB2 = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', sharedUuid)
      .send({ amount: '200000.00', description: 'User B withdraw' })
      .expect(200);

    expect(resA2.body).toEqual(resA1.body);
    expect(resB2.body).toEqual(resB1.body);

    await assertLedgerInvariants(dataSource);
  });

  it('I9: replay returns the original COMPLETED snapshot even after the transaction is later REVERSED by Admin', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'I9-Admin');
    const sender = await createAuthenticatedAccount(
      app,
      'I9-Sender',
      '500000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'I9-Receiver',
      '100000.00',
    );

    const transferKey = randomUUID();
    const transferPayload = {
      toAccountNumber: receiver.accountNumber,
      amount: '150000.00',
      description: 'I9 snapshot immutability test',
    };

    // 1. User A chuyển 150,000 cho User B -> 201 Created (bản chụp lưu status = COMPLETED)
    const initialRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', transferKey)
      .send(transferPayload)
      .expect(201);

    expect(initialRes.body.status).toBe(TransactionStatus.COMPLETED);
    expect(initialRes.body.reversalTransactionId).toBeNull();

    // 2. Admin hoàn tiền giao dịch này -> Bản ghi trong bảng transactions chuyển sang REVERSED
    await request(httpServer)
      .post(`/api/transactions/${initialRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'I9 admin reversal' })
      .expect(201);

    const txInDb = await txRepo.findOneByOrFail({ id: initialRes.body.id });
    expect(txInDb.status).toBe(TransactionStatus.REVERSED);

    // 3. User A gửi lại (Replay) đúng transferKey ban đầu -> Vẫn nhận 200 OK kèm bản chụp COMPLETED ban đầu!
    const replayRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', transferKey)
      .send(transferPayload)
      .expect(200);

    expect(replayRes.body).toEqual(initialRes.body);
    expect(replayRes.body.status).toBe(TransactionStatus.COMPLETED);
    expect(replayRes.body.reversalTransactionId).toBeNull();

    await assertLedgerInvariants(dataSource);
  });

  it('I10: sweepStuckTransactions() marks both the stuck PROCESSING transaction and its IN_PROGRESS idempotency key as FAILED/503, and subsequent replay returns the saved 503 error', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const user = await createAuthenticatedAccount(app, 'I10-User', '500000.00');

    const stuckKey = randomUUID();
    const withdrawPayload = {
      amount: '80000.00',
      description: 'I10 stuck withdraw',
    };
    const requestHash = idempotencyService.computeRequestHash({
      operation: 'WITHDRAW',
      amount: withdrawPayload.amount,
      description: withdrawPayload.description,
    });

    const oldDate = new Date(Date.now() - 300 * 1000); // 5 phút trước (> 120s)

    // 1. Tạo phiếu PROCESSING cũ và dòng khóa IN_PROGRESS tương ứng
    const stuckTx = await txRepo.save(
      txRepo.create({
        actor_account_id: user.accountId,
        from_account_id: user.accountId,
        to_account_id: null,
        amount: '80000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: withdrawPayload.description,
        created_at: oldDate,
      }),
    );
    await dataSource.query(
      `UPDATE "transactions" SET "updated_at" = $1 WHERE "id" = $2`,
      [oldDate, stuckTx.id],
    );

    await idemRepo.save(
      idemRepo.create({
        user_id: user.userId,
        idempotency_key: stuckKey,
        request_hash: requestHash,
        status: IdempotencyKeyStatus.IN_PROGRESS,
        response_status: null,
        response_body: null,
        transaction_id: stuckTx.id,
        expired_at: new Date(Date.now() + 24 * 3600 * 1000),
      }),
    );

    // 2. Chạy sweepStuckTransactions()
    const sweepResult = await transactionsService.sweepStuckTransactions();
    expect(sweepResult.sweptCount).toBe(1);
    expect(sweepResult.sweptIds).toContain(stuckTx.id);

    // 3. Kiểm tra cả bảng transactions và bảng idempotency_keys đều đã chuyển sang FAILED
    const txAfter = await txRepo.findOneByOrFail({ id: stuckTx.id });
    expect(txAfter.status).toBe(TransactionStatus.FAILED);
    expect(txAfter.failure_code).toBe(TransactionFailureCode.TIMEOUT);

    const keyAfter = await idemRepo.findOneByOrFail({
      user_id: user.userId,
      idempotency_key: stuckKey,
    });
    expect(keyAfter.status).toBe(IdempotencyKeyStatus.FAILED);
    expect(keyAfter.response_status).toBe(503);

    // 4. Gửi lại request với cùng stuckKey -> Nhận đúng 503 đã lưu trong bản chụp (không còn nhận 202!)
    const replayRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', stuckKey)
      .send(withdrawPayload)
      .expect(503);

    expect(replayRes.body.message).toBe(
      'Giao dịch bị quá thời gian xử lý, vui lòng thử lại',
    );

    await assertLedgerInvariants(dataSource);
  });
});
