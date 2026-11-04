import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { User, UserRole } from '../../src/database/entities/user.entity';

export interface TestAccountContext {
  userId: string;
  email: string;
  token: string;
  accountId: string;
  accountNumber: string;
  balance: string;
}

/**
 * Khởi tạo ứng dụng NestJS phục vụ E2E test và chạy toàn bộ migrations trên DB test.
 * Chốt chặn an toàn: từ chối chạy nếu tên database không kết thúc bằng "_test".
 */
export async function createTestApp(): Promise<{
  app: INestApplication<App>;
  dataSource: DataSource;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  const dataSource = app.get(DataSource);
  const dbName = String(dataSource.options.database || '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Safety abort: E2E test must run on a *_test database, current is "${dbName}"`,
    );
  }

  await dataSource.runMigrations();
  return { app, dataSource };
}

/**
 * Làm sạch dữ liệu giữa các bài test để mỗi test độc lập hoàn toàn.
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE TABLE "idempotency_keys", "ledger_entries", "transactions", "accounts", "users" RESTART IDENTITY CASCADE',
  );
}

/**
 * Kiểm tra bộ 5 bất biến sổ cái kép & vòng đời giao dịch (Q1', Q2, Q3, Q4, Q5).
 * Kỳ vọng tất cả truy vấn đều trả về 0 dòng sai lệch.
 */
export async function assertLedgerInvariants(
  dataSource: DataSource,
): Promise<void> {
  // Q1' — Bút toán đúng theo loại và trạng thái (chưa/không hoàn tất thì 0 bút toán; COMPLETED/REVERSED đủ và cân)
  const q1Violations = await dataSource.query(`
    SELECT t.id, t.type, t.status
    FROM "transactions" t
    LEFT JOIN "ledger_entries" le ON le.transaction_id = t.id
    GROUP BY t.id, t.type, t.status, t.amount, t.original_transaction_id
    HAVING CASE
      WHEN t.status NOT IN ('COMPLETED', 'REVERSED') THEN COUNT(le.id) <> 0
      WHEN t.type = 'TRANSFER' THEN
           COUNT(le.id) <> 2
        OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0)  <> t.amount
        OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
      WHEN t.type = 'DEPOSIT' THEN
           COUNT(le.id) <> 1
        OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
      WHEN t.type = 'WITHDRAW' THEN
           COUNT(le.id) <> 1
        OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0) <> t.amount
      WHEN t.type = 'REVERSAL' THEN
           COUNT(le.id) <> (SELECT COUNT(*) FROM "ledger_entries" o WHERE o.transaction_id = t.original_transaction_id)
    END
  `);
  expect(q1Violations).toEqual([]);

  // Q2 — Số dư hiển thị (accounts.balance) khớp tổng bút toán của từng tài khoản
  const q2Violations = await dataSource.query(`
    SELECT a.account_number, a.balance,
           COALESCE(SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END), 0) AS computed
    FROM "accounts" a
    LEFT JOIN "ledger_entries" le ON le.account_id = a.id
    GROUP BY a.id, a.account_number, a.balance
    HAVING a.balance <> COALESCE(SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END), 0)
  `);
  expect(q2Violations).toEqual([]);

  // Q3 — Cột balance_after của từng dòng khớp với số dư cộng dồn theo thứ tự id
  const q3Violations = await dataSource.query(`
    SELECT x.id, x.account_id, x.balance_after, x.running
    FROM (
      SELECT le.id, le.account_id, le.balance_after,
             SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END)
               OVER (PARTITION BY le.account_id ORDER BY le.id) AS running
      FROM "ledger_entries" le
    ) x
    WHERE x.balance_after <> x.running
  `);
  expect(q3Violations).toEqual([]);

  // Q4 — Mỗi cặp (gốc, hoàn tiền COMPLETED) triệt tiêu nhau trên từng tài khoản
  const q4Violations = await dataSource.query(`
    SELECT o.id AS original_id, le.account_id,
           SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END) AS net
    FROM "transactions" o
    JOIN "transactions" r ON r.original_transaction_id = o.id AND r.type = 'REVERSAL' AND r.status = 'COMPLETED'
    JOIN "ledger_entries" le ON le.transaction_id IN (o.id, r.id)
    GROUP BY o.id, le.account_id
    HAVING SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END) <> 0
  `);
  expect(q4Violations).toEqual([]);

  // Q5 — Trạng thái của giao dịch gốc (REVERSED) và giao dịch hoàn tiền (REVERSAL COMPLETED) nhất quán
  const q5Violations = await dataSource.query(`
    SELECT o.id FROM "transactions" o
    WHERE o.status = 'REVERSED'
      AND (SELECT COUNT(*) FROM "transactions" r
           WHERE r.original_transaction_id = o.id AND r.type = 'REVERSAL' AND r.status = 'COMPLETED') <> 1
    UNION ALL
    SELECT r.id FROM "transactions" r
    WHERE r.type = 'REVERSAL' AND r.status = 'COMPLETED'
      AND NOT EXISTS (SELECT 1 FROM "transactions" o WHERE o.id = r.original_transaction_id AND o.status = 'REVERSED')
  `);
  expect(q5Violations).toEqual([]);
}

/**
 * Helper tạo nhanh 1 user mới -> đăng nhập lấy JWT -> nạp số dư khởi tạo (nếu > 0)
 */
export async function createAuthenticatedAccount(
  app: INestApplication<App>,
  label: string,
  initialDeposit?: string,
): Promise<TestAccountContext> {
  const httpServer = app.getHttpServer();
  const uniqueSuffix = randomUUID().slice(0, 8);
  const email = `e2e-${label.toLowerCase()}-${uniqueSuffix}@bank.local`;
  const password = 'Password@123';

  // 1. Đăng ký
  const regRes = await request(httpServer)
    .post('/api/auth/register')
    .send({
      fullName: `E2E User ${label}`,
      email,
      password,
    })
    .expect(201);

  // 2. Đăng nhập
  const loginRes = await request(httpServer)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  const token: string = loginRes.body.accessToken;

  // 3. Nạp số dư ban đầu nếu được yêu cầu
  if (initialDeposit && parseFloat(initialDeposit) > 0) {
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: initialDeposit,
        description: `Initial deposit for ${label}`,
      })
      .expect(201);
  }

  // 4. Đọc thông tin tài khoản
  const meRes = await request(httpServer)
    .get('/api/accounts/me')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  return {
    userId: regRes.body.user.id,
    email,
    token,
    accountId: meRes.body.id,
    accountNumber: meRes.body.accountNumber,
    balance: meRes.body.balance,
  };
}

/**
 * Helper tạo nhanh 1 tài khoản Admin (role = UserRole.ADMIN) phục vụ test hoàn tiền REVERSAL
 */
export async function createAuthenticatedAdmin(
  app: INestApplication<App>,
  dataSource: DataSource,
  label = 'Admin',
): Promise<TestAccountContext> {
  const ctx = await createAuthenticatedAccount(app, label);
  await dataSource
    .getRepository(User)
    .update({ id: ctx.userId }, { role: UserRole.ADMIN });
  return ctx;
}
