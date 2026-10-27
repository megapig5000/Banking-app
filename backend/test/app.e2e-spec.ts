import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from './../src/app.module';

describe('Simple Banking App Smoke (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    const dbName = String(dataSource.options.database || '');
    if (!dbName.endsWith('_test')) {
      throw new Error(
        `Safety abort: E2E test must run on a *_test database, current is "${dbName}"`,
      );
    }

    await dataSource.runMigrations();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE "transactions", "accounts", "users" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('registers, logs in, reads initial balance, deposits money, and verifies updated balance', async () => {
    const httpServer = app.getHttpServer();

    // 1. Đăng ký tài khoản
    const registerRes = await request(httpServer)
      .post('/api/auth/register')
      .send({
        fullName: 'Smoke Test User',
        email: 'smoketest@bank.local',
        password: 'Password@123',
      })
      .expect(201);

    expect(registerRes.body.user.email).toBe('smoketest@bank.local');
    expect(registerRes.body.user.password_hash).toBeUndefined();

    // 2. Đăng nhập lấy JWT
    const loginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({
        email: 'smoketest@bank.local',
        password: 'Password@123',
      })
      .expect(200);

    const token: string = loginRes.body.accessToken;
    expect(token).toBeDefined();

    // 3. Kiểm tra tài khoản mới có số dư = 0.00
    const initialAccountRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(initialAccountRes.body.balance).toBe('0.00');
    expect(initialAccountRes.body.currency).toBe('VND');

    // 4. Nạp 250,000.00 VND vào tài khoản
    const idempotencyKey = randomUUID();
    const depositRes = await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        amount: '250000.00',
        description: 'Smoke test initial deposit',
      })
      .expect(201);

    expect(depositRes.body.type).toBe('deposit');
    expect(depositRes.body.direction).toBe('incoming');
    expect(depositRes.body.amount).toBe('250000.00');
    expect(depositRes.body.counterpartyAccountNumber).toBeNull();

    // 5. Kiểm tra lại số dư đã tăng lên 250,000.00 VND
    const updatedAccountRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(updatedAccountRes.body.balance).toBe('250000.00');
  });
});
