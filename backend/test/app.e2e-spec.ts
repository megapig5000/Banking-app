import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createTestApp, resetDatabase } from './helpers/e2e-test.helper';

describe('Simple Banking App Smoke (e2e)', () => {
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

  it('registers, logs in, reads initial balance, deposits money, and verifies updated balance', async () => {
    const httpServer = app.getHttpServer();

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

    const loginRes = await request(httpServer)
      .post('/api/auth/login')
      .send({
        email: 'smoketest@bank.local',
        password: 'Password@123',
      })
      .expect(200);

    const token: string = loginRes.body.accessToken;
    expect(token).toBeDefined();

    const initialAccountRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(initialAccountRes.body.balance).toBe('0.00');
    expect(initialAccountRes.body.currency).toBe('VND');

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

    const updatedAccountRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(updatedAccountRes.body.balance).toBe('250000.00');
  });
});
