import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';

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
 * Làm sạch dữ liệu giữa các bài test để mỗi test độc lập hoàn toàn
 */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    'TRUNCATE TABLE "transactions", "accounts", "users" RESTART IDENTITY CASCADE',
  );
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
