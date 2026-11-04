import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  LedgerEntry,
  LedgerEntryType,
} from '../src/database/entities/ledger-entry.entity';
import {
  Transaction,
  TransactionStatus,
} from '../src/database/entities/transaction.entity';
import {
  IdempotencyKey,
  IdempotencyKeyStatus,
} from '../src/database/entities/idempotency-key.entity';
import { TransactionFailureCode } from '../src/transactions/transactions.constants';
import { TransactionsService } from '../src/transactions/transactions.service';
import {
  assertLedgerInvariants,
  createAuthenticatedAccount,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

jest.setTimeout(30000);

describe('Module 3A (3.1 & 7.3) — Double-entry Ledger & Mid-Transaction Rollback (e2e)', () => {
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
  // BÀI 3.1 — SỔ CÁI KÉP (L1, L2, L3)
  // =========================================================================

  it('L1: blocks UPDATE and DELETE on ledger_entries via both TypeORM Repository and raw SQL (immutability trigger)', async () => {
    await createAuthenticatedAccount(app, 'L1-User', '500000.00');

    const ledgerRepo = dataSource.getRepository(LedgerEntry);
    const entriesBefore = await ledgerRepo.find();
    expect(entriesBefore).toHaveLength(1);

    const targetEntry = entriesBefore[0];
    expect(targetEntry.amount).toBe('500000.00');
    expect(targetEntry.balance_after).toBe('500000.00');

    // 1. Thử UPDATE qua TypeORM Repository -> Bị chặn bởi trigger
    await expect(
      ledgerRepo.update({ id: targetEntry.id }, { amount: '999999.00' }),
    ).rejects.toThrow(/ledger_entries is append-only/i);

    // 2. Thử DELETE qua TypeORM Repository -> Bị chặn bởi trigger
    await expect(ledgerRepo.delete({ id: targetEntry.id })).rejects.toThrow(
      /ledger_entries is append-only/i,
    );

    // 3. Thử UPDATE bằng SQL thô -> Bị chặn bởi trigger
    await expect(
      dataSource.query(
        `UPDATE "ledger_entries" SET "amount" = 1.00 WHERE "id" = $1`,
        [targetEntry.id],
      ),
    ).rejects.toThrow(/ledger_entries is append-only/i);

    // 4. Thử DELETE bằng SQL thô -> Bị chặn bởi trigger
    await expect(
      dataSource.query(`DELETE FROM "ledger_entries" WHERE "id" = $1`, [
        targetEntry.id,
      ]),
    ).rejects.toThrow(/ledger_entries is append-only/i);

    // Khẳng định dữ liệu bút toán vẫn nguyên vẹn 100%
    const entryAfter = await ledgerRepo.findOneByOrFail({ id: targetEntry.id });
    expect(entryAfter.amount).toBe('500000.00');
    expect(entryAfter.balance_after).toBe('500000.00');
    expect(entryAfter.type).toBe(LedgerEntryType.CREDIT);

    await assertLedgerInvariants(dataSource);
  });

  it('L2: account balance from GET /accounts/me matches exact sum of ledger_entries after deposit, withdraw, and transfer sequence', async () => {
    const httpServer = app.getHttpServer();

    const userA = await createAuthenticatedAccount(app, 'L2-A', '1000000.00');
    const userB = await createAuthenticatedAccount(app, 'L2-B', '300000.00');

    // 1. User A nạp thêm 250,000 -> A = 1,250,000
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '250000.00', description: 'L2 deposit A' })
      .expect(201);

    // 2. User A rút 150,000 -> A = 1,100,000
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '150000.00', description: 'L2 withdraw A' })
      .expect(201);

    // 3. User A chuyển 400,000 sang User B -> A = 700,000, B = 700,000
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '400000.00',
        description: 'L2 transfer A->B',
      })
      .expect(201);

    // 4. User B chuyển ngược 120,000 sang User A -> A = 820,000, B = 580,000
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userA.accountNumber,
        amount: '120000.00',
        description: 'L2 transfer B->A',
      })
      .expect(201);

    const meA = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    const meB = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    expect(meA.body.balance).toBe('820000.00');
    expect(meB.body.balance).toBe('580000.00');

    // Tính tổng từ bảng ledger_entries bằng SQL cho từng tài khoản
    const rows: Array<{ account_id: string; ledger_sum: string }> =
      await dataSource.query(
        `
        SELECT account_id,
               SUM(CASE type WHEN 'CREDIT' THEN amount ELSE -amount END)::numeric(18,2) AS ledger_sum
        FROM "ledger_entries"
        WHERE account_id IN ($1, $2)
        GROUP BY account_id
        `,
        [userA.accountId, userB.accountId],
      );

    const sumMap = new Map(rows.map((r) => [r.account_id, r.ledger_sum]));
    expect(sumMap.get(userA.accountId)).toBe(meA.body.balance);
    expect(sumMap.get(userB.accountId)).toBe(meB.body.balance);

    await assertLedgerInvariants(dataSource);
  });

  it('L3: generates exact ledger entries per transaction type (deposit=1 CREDIT, withdraw=1 DEBIT, transfer=1 DEBIT + 1 CREDIT) and idempotency replay creates 0 extra entries', async () => {
    const httpServer = app.getHttpServer();
    const ledgerRepo = dataSource.getRepository(LedgerEntry);

    const userA = await createAuthenticatedAccount(app, 'L3-A');
    const userB = await createAuthenticatedAccount(app, 'L3-B');

    // 1. Deposit 500,000 -> 1 bút toán CREDIT
    const depKey = randomUUID();
    const depRes = await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', depKey)
      .send({ amount: '500000.00', description: 'L3 deposit' })
      .expect(201);

    // Gửi replay cùng key cho deposit -> 200 OK, không sinh thêm bút toán
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', depKey)
      .send({ amount: '500000.00', description: 'L3 deposit' })
      .expect(200);

    const depEntries = await ledgerRepo.find({
      where: { transaction_id: depRes.body.id },
    });
    expect(depEntries).toHaveLength(1);
    expect(depEntries[0].type).toBe(LedgerEntryType.CREDIT);
    expect(depEntries[0].account_id).toBe(userA.accountId);
    expect(depEntries[0].amount).toBe('500000.00');
    expect(depEntries[0].balance_after).toBe('500000.00');

    // 2. Withdraw 100,000 -> 1 bút toán DEBIT
    const witKey = randomUUID();
    const witRes = await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', witKey)
      .send({ amount: '100000.00', description: 'L3 withdraw' })
      .expect(201);

    const witEntries = await ledgerRepo.find({
      where: { transaction_id: witRes.body.id },
    });
    expect(witEntries).toHaveLength(1);
    expect(witEntries[0].type).toBe(LedgerEntryType.DEBIT);
    expect(witEntries[0].account_id).toBe(userA.accountId);
    expect(witEntries[0].amount).toBe('100000.00');
    expect(witEntries[0].balance_after).toBe('400000.00');

    // 3. Transfer 150,000 A -> B -> 2 bút toán (1 DEBIT A + 1 CREDIT B)
    const tfKey = randomUUID();
    const tfPayload = {
      toAccountNumber: userB.accountNumber,
      amount: '150000.00',
      description: 'L3 transfer',
    };

    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', tfKey)
      .send(tfPayload)
      .expect(201);

    // Gửi replay cùng key cho transfer -> 200 OK, vẫn chỉ có đúng 2 bút toán
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', tfKey)
      .send(tfPayload)
      .expect(200);

    const tfEntries = await ledgerRepo.find({
      where: { transaction_id: tfRes.body.id },
      order: { id: 'ASC' },
    });
    expect(tfEntries).toHaveLength(2);

    const debitEntry = tfEntries.find((e) => e.type === LedgerEntryType.DEBIT);
    const creditEntry = tfEntries.find(
      (e) => e.type === LedgerEntryType.CREDIT,
    );

    expect(debitEntry).toBeDefined();
    expect(debitEntry?.account_id).toBe(userA.accountId);
    expect(debitEntry?.amount).toBe('150000.00');
    expect(debitEntry?.balance_after).toBe('250000.00');

    expect(creditEntry).toBeDefined();
    expect(creditEntry?.account_id).toBe(userB.accountId);
    expect(creditEntry?.amount).toBe('150000.00');
    expect(creditEntry?.balance_after).toBe('150000.00');

    // Tổng số bút toán của cả 3 giao dịch (1 + 1 + 2 = 4)
    expect(await ledgerRepo.count()).toBe(4);
    await assertLedgerInvariants(dataSource);
  });

  // =========================================================================
  // BÀI 7.3 — TEST ROLLBACK KHI LỖI GIỮA CHỪNG (R1, R2 - CẬP NHẬT CHO MODULE 2 & 3B)
  // =========================================================================

  it('R1: rolls back sender debit completely when an error occurs right after debitAccount and before creditAccount (records FAILED transaction & idempotency key with 0 ledger entries)', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'R1-Sender',
      '1000000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'R1-Receiver',
      '200000.00',
    );

    const ledgerCountBefore = await ledgerRepo.count();

    // Giả lập lỗi ngay tại bước cộng tiền tài khoản đích (sau khi đã trừ tiền tài khoản nguồn)
    const creditSpy = jest
      .spyOn(transactionsService as any, 'creditAccount')
      .mockRejectedValueOnce(
        new Error('Simulated DB failure before creditAccount'),
      );

    const failedKey = randomUUID();
    const res = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', failedKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '300000.00',
        description: 'R1 mid-transaction failure test',
      })
      .expect(500);

    expect(creditSpy).toHaveBeenCalledTimes(1);
    expect(res.body.message).toBe('Lỗi hệ thống khi thực hiện giao dịch');

    // 1. Số dư của cả A và B hoàn toàn không đổi (khoản trừ 300,000 của A ở Pha B đã được rollback)
    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    const meReceiver = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${receiver.token}`)
      .expect(200);

    expect(meSender.body.balance).toBe('1000000.00');
    expect(meReceiver.body.balance).toBe('200000.00');

    // 2. Dòng khóa trong idempotency_keys và phiếu giao dịch đều ở trạng thái FAILED, nhưng 0 bút toán mới
    const idemRecord = await idemRepo.findOneByOrFail({
      user_id: sender.userId,
      idempotency_key: failedKey,
    });
    expect(idemRecord.status).toBe(IdempotencyKeyStatus.FAILED);
    expect(idemRecord.response_status).toBe(500);
    expect(idemRecord.transaction_id).toBeDefined();

    const failedTx = await txRepo.findOneByOrFail({
      id: idemRecord.transaction_id!,
    });
    expect(failedTx.status).toBe(TransactionStatus.FAILED);
    expect(failedTx.failure_code).toBe(TransactionFailureCode.INTERNAL_ERROR);
    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    await assertLedgerInvariants(dataSource);
  });

  it('R2: rolls back Phase B completely (no orphaned DEBIT entry, records FAILED transaction & idempotency key) when an error occurs after inserting DEBIT ledger entry and before inserting CREDIT ledger entry', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);
    const ledgerRepo = dataSource.getRepository(LedgerEntry);
    const idemRepo = dataSource.getRepository(IdempotencyKey);

    const sender = await createAuthenticatedAccount(
      app,
      'R2-Sender',
      '1000000.00',
    );
    const receiver = await createAuthenticatedAccount(
      app,
      'R2-Receiver',
      '200000.00',
    );

    const ledgerCountBefore = await ledgerRepo.count();

    // Giả lập lỗi trong insertLedgerEntries:
    // Cho phép ghi thật bút toán đầu tiên (DEBIT của A) vào DB trong transaction Pha B,
    // sau đó ném lỗi ngay trước khi ghi bút toán thứ hai (CREDIT của B).
    const insertLedgerSpy = jest
      .spyOn(transactionsService as any, 'insertLedgerEntries')
      .mockImplementationOnce(async (...args: unknown[]) => {
        const [manager, entries] = args as [
          EntityManager,
          Array<{
            accountId: string;
            transactionId: string;
            type: LedgerEntryType;
            amount: string;
            balanceAfter: string;
          }>,
        ];
        const first = entries[0];
        await manager.insert(LedgerEntry, {
          account_id: first.accountId,
          transaction_id: first.transactionId,
          type: first.type,
          amount: first.amount,
          balance_after: first.balanceAfter,
        });
        throw new Error(
          'Simulated crash right after DEBIT ledger entry and before CREDIT ledger entry',
        );
      });

    const failedKey = randomUUID();
    const res = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${sender.token}`)
      .set('Idempotency-Key', failedKey)
      .send({
        toAccountNumber: receiver.accountNumber,
        amount: '400000.00',
        description: 'R2 orphaned ledger entry prevention test',
      })
      .expect(500);

    expect(insertLedgerSpy).toHaveBeenCalledTimes(1);
    expect(res.body.message).toBe('Lỗi hệ thống khi thực hiện giao dịch');

    // 1. Số dư của A và B được khôi phục nguyên vẹn
    const meSender = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);
    const meReceiver = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${receiver.token}`)
      .expect(200);

    expect(meSender.body.balance).toBe('1000000.00');
    expect(meReceiver.body.balance).toBe('200000.00');

    // 2. Có đúng 1 phiếu FAILED (INTERNAL_ERROR) và tuyệt đối không có bút toán DEBIT mồ côi nào trong DB
    const idemRecord = await idemRepo.findOneByOrFail({
      user_id: sender.userId,
      idempotency_key: failedKey,
    });
    expect(idemRecord.status).toBe(IdempotencyKeyStatus.FAILED);
    expect(idemRecord.response_status).toBe(500);
    expect(idemRecord.transaction_id).toBeDefined();

    const failedTx = await txRepo.findOneByOrFail({
      id: idemRecord.transaction_id!,
    });
    expect(failedTx.status).toBe(TransactionStatus.FAILED);
    expect(failedTx.failure_code).toBe(TransactionFailureCode.INTERNAL_ERROR);
    expect(await ledgerRepo.count()).toBe(ledgerCountBefore);

    await assertLedgerInvariants(dataSource);
  });
});
