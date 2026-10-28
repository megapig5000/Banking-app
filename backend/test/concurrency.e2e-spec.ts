import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Transaction } from '../src/database/entities/transaction.entity';
import {
  createAuthenticatedAccount,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

// Tăng timeout cho Jest vì các bài test bắn nhiều request đồng thời qua 5 vòng liên tiếp
// và xếp hàng chờ khóa SELECT ... FOR UPDATE cũng như chờ kết nối trong DB pool.
jest.setTimeout(60000);

describe('Module 1 & 7.2 — Concurrency Integration Tests (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const setup = await createTestApp();
    app = setup.app;
    dataSource = setup.dataSource;
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('T1: 20 concurrent withdrawals of 100,000 on 1,000,000 balance -> exactly 10 succeed (201), 10 fail (422), final balance = 0.00 (5 iterations)', async () => {
    const httpServer = app.getHttpServer();
    const iterations = 5;

    for (let round = 1; round <= iterations; round++) {
      await resetDatabase(dataSource);

      const acc = await createAuthenticatedAccount(
        app,
        `T1-R${round}`,
        '1000000.00',
      );

      // Bắn 20 request rút 100,000.00 đồng thời, mỗi request 1 Idempotency-Key riêng
      const tasks = Array.from({ length: 20 }, (_, idx) =>
        request(httpServer)
          .post('/api/transactions/withdraw')
          .set('Authorization', `Bearer ${acc.token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            amount: '100000.00',
            description: `T1 round ${round} withdraw #${idx + 1}`,
          }),
      );

      const responses = await Promise.all(tasks);

      const count201 = responses.filter((r) => r.status === 201).length;
      const count422 = responses.filter((r) => r.status === 422).length;
      const count500 = responses.filter((r) => r.status === 500).length;

      expect(count500).toBe(0);
      expect(count201).toBe(10);
      expect(count422).toBe(10);

      // Kiểm tra số dư cuối cùng trong DB phải chính xác tuyệt đối = 0.00
      const meRes = await request(httpServer)
        .get('/api/accounts/me')
        .set('Authorization', `Bearer ${acc.token}`)
        .expect(200);

      expect(meRes.body.balance).toBe('0.00');
    }
  });

  it('T2: concurrent bidirectional transfers A->B and B->A -> no deadlock/500, total balance A+B conserved (5 rounds)', async () => {
    const httpServer = app.getHttpServer();
    const initialBalance = 5000000;
    const transferAmount = 10000;
    const pairsPerRound = 10;
    const rounds = 5;

    const accA = await createAuthenticatedAccount(
      app,
      'T2-A',
      initialBalance.toFixed(2),
    );
    const accB = await createAuthenticatedAccount(
      app,
      'T2-B',
      initialBalance.toFixed(2),
    );

    let totalSuccessAtoB = 0;
    let totalSuccessBtoA = 0;

    for (let round = 1; round <= rounds; round++) {
      const tasks: Array<
        Promise<{ status: number; direction: 'AtoB' | 'BtoA' }>
      > = [];

      for (let p = 0; p < pairsPerRound; p++) {
        tasks.push(
          request(httpServer)
            .post('/api/transactions/transfer')
            .set('Authorization', `Bearer ${accA.token}`)
            .set('Idempotency-Key', randomUUID())
            .send({
              toAccountNumber: accB.accountNumber,
              amount: transferAmount.toFixed(2),
              description: `T2 R${round} P${p + 1} A->B`,
            })
            .then((res) => ({
              status: res.status,
              direction: 'AtoB' as const,
            })),
        );

        tasks.push(
          request(httpServer)
            .post('/api/transactions/transfer')
            .set('Authorization', `Bearer ${accB.token}`)
            .set('Idempotency-Key', randomUUID())
            .send({
              toAccountNumber: accA.accountNumber,
              amount: transferAmount.toFixed(2),
              description: `T2 R${round} P${p + 1} B->A`,
            })
            .then((res) => ({
              status: res.status,
              direction: 'BtoA' as const,
            })),
        );
      }

      const results = await Promise.all(tasks);

      for (const r of results) {
        expect(r.status).not.toBe(500);
        if (r.status === 201 || r.status === 200) {
          if (r.direction === 'AtoB') totalSuccessAtoB += 1;
          else totalSuccessBtoA += 1;
        }
      }
    }

    const finalARes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${accA.token}`)
      .expect(200);
    const finalBRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${accB.token}`)
      .expect(200);

    const actualA = parseFloat(finalARes.body.balance);
    const actualB = parseFloat(finalBRes.body.balance);

    const expectedA =
      initialBalance -
      totalSuccessAtoB * transferAmount +
      totalSuccessBtoA * transferAmount;
    const expectedB =
      initialBalance -
      totalSuccessBtoA * transferAmount +
      totalSuccessAtoB * transferAmount;

    // 1. Tổng số dư A + B không đổi (bảo toàn tiền)
    expect(actualA + actualB).toBe(initialBalance * 2);
    // 2. Số dư từng bên khớp chính xác với số lần thành công mỗi chiều
    expect(actualA).toBe(expectedA);
    expect(actualB).toBe(expectedB);
    expect(totalSuccessAtoB).toBe(pairsPerRound * rounds);
    expect(totalSuccessBtoA).toBe(pairsPerRound * rounds);
  });

  it('T3: 5 concurrent requests with the SAME Idempotency-Key and payload -> only 1 transaction created, all return same transaction (5 iterations)', async () => {
    const httpServer = app.getHttpServer();
    const iterations = 5;

    for (let round = 1; round <= iterations; round++) {
      await resetDatabase(dataSource);

      const sender = await createAuthenticatedAccount(
        app,
        `T3-Sender-${round}`,
        '500000.00',
      );
      const receiver = await createAuthenticatedAccount(
        app,
        `T3-Receiver-${round}`,
        '0.00',
      );

      // Dùng CHUNG một Idempotency-Key cho cả 5 request đồng thời
      // Lưu ý: Số tiền chuyển = 500,000.00 (rút cạn 100% số dư) để kiểm chứng luôn
      // việc các request đồng thời cùng key không bị báo nhầm 422 Không đủ số dư.
      const sharedKey = randomUUID();
      const payload = {
        toAccountNumber: receiver.accountNumber,
        amount: '500000.00',
        description: `T3 concurrent same key round ${round}`,
      };

      const tasks = Array.from({ length: 5 }, () =>
        request(httpServer)
          .post('/api/transactions/transfer')
          .set('Authorization', `Bearer ${sender.token}`)
          .set('Idempotency-Key', sharedKey)
          .send(payload),
      );

      const responses = await Promise.all(tasks);

      // Tất cả 5 request phải trả về 201 (tạo mới) hoặc 200 (replay), tuyệt đối không có 422 hay 500
      for (const res of responses) {
        expect([200, 201]).toContain(res.status);
      }

      const count201 = responses.filter((r) => r.status === 201).length;
      const count200 = responses.filter((r) => r.status === 200).length;
      expect(count201).toBe(1);
      expect(count200).toBe(4);

      // Cả 5 response phải trả về CÙNG một ID giao dịch
      const txIds = new Set(responses.map((r) => r.body.id));
      expect(txIds.size).toBe(1);

      // Trong DB chỉ có đúng 1 bản ghi giao dịch với idempotency_key này
      const dbTxCount = await dataSource.getRepository(Transaction).count({
        where: { idempotency_key: sharedKey },
      });
      expect(dbTxCount).toBe(1);

      // Số dư người gửi chỉ bị trừ đúng 1 lần (về 0.00), người nhận tăng lên 500,000.00
      const senderMe = await request(httpServer)
        .get('/api/accounts/me')
        .set('Authorization', `Bearer ${sender.token}`)
        .expect(200);
      const receiverMe = await request(httpServer)
        .get('/api/accounts/me')
        .set('Authorization', `Bearer ${receiver.token}`)
        .expect(200);

      expect(senderMe.body.balance).toBe('0.00');
      expect(receiverMe.body.balance).toBe('500000.00');
    }
  });
});
