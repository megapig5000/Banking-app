import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  User,
  UserRole,
  UserStatus,
} from '../src/database/entities/user.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { AuditAction, AuditEntity } from '../src/audit/audit.constants';
import {
  assertAuditInvariants,
  assertLedgerInvariants,
  createAuthenticatedAccount,
  createAuthenticatedAdmin,
  createTestApp,
  resetDatabase,
} from './helpers/e2e-test.helper';

jest.setTimeout(60000);

describe('Module 4A (3.3 & 4.1) — RBAC, Admin APIs & Automated Audit Trail (e2e)', () => {
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
  // RB1 -> RB4 — KIỂM THỬ PHÂN QUYỀN RBAC (BÀI 4.1 PHẦN CƠ BẢN)
  // =========================================================================

  it('RB1: CUSTOMER calling GET /accounts/:accountNumber for another user gets 403, for own account gets 200; ADMIN can view any account and gets 404 for non-existent account', async () => {
    const httpServer = app.getHttpServer();

    const customerA = await createAuthenticatedAccount(
      app,
      'RB1-CustA',
      '500000.00',
    );
    const customerB = await createAuthenticatedAccount(
      app,
      'RB1-CustB',
      '300000.00',
    );
    const admin = await createAuthenticatedAdmin(app, dataSource, 'RB1-Admin');

    // 1. CUSTOMER A xem tài khoản CỦA NGƯỜI KHÁC (Customer B) -> 403 Forbidden (đúng kịch bản đề bài 4.1)
    const custViewOtherRes = await request(httpServer)
      .get(`/api/accounts/${customerB.accountNumber}`)
      .set('Authorization', `Bearer ${customerA.token}`)
      .expect(403);

    expect(custViewOtherRes.body.message).toMatch(/không có quyền/i);

    // 2. CUSTOMER A xem tài khoản CỦA CHÍNH MÌNH -> 200 OK
    const custViewOwnRes = await request(httpServer)
      .get(`/api/accounts/${customerA.accountNumber}`)
      .set('Authorization', `Bearer ${customerA.token}`)
      .expect(200);

    expect(custViewOwnRes.body.accountNumber).toBe(customerA.accountNumber);
    expect(custViewOwnRes.body.balance).toBe('500000.00');

    // 3. ADMIN xem tài khoản của cả Customer A và Customer B -> 200 OK
    const adminViewARes = await request(httpServer)
      .get(`/api/accounts/${customerA.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const adminViewBRes = await request(httpServer)
      .get(`/api/accounts/${customerB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(adminViewARes.body.id).toBe(customerA.accountId);
    expect(adminViewBRes.body.id).toBe(customerB.accountId);

    // 4. ADMIN tra cứu số tài khoản không tồn tại -> 404 Not Found
    await request(httpServer)
      .get('/api/accounts/9999999999')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('RB2: unauthenticated requests get 401 across all protected endpoints; CUSTOMER calling /admin/* or reverse gets 403', async () => {
    const httpServer = app.getHttpServer();
    const customer = await createAuthenticatedAccount(app, 'RB2-Cust');
    const fakeUuid = randomUUID();

    // 1. Không có token -> 401 Unauthorized cho toàn bộ các endpoint trong ma trận quyền
    await request(httpServer).get('/api/accounts/me').expect(401);
    await request(httpServer)
      .get(`/api/accounts/${customer.accountNumber}`)
      .expect(401);
    await request(httpServer).get('/api/transactions').expect(401);
    await request(httpServer)
      .post('/api/transactions/deposit')
      .send({ amount: '10000.00' })
      .expect(401);
    await request(httpServer)
      .post(`/api/transactions/${fakeUuid}/reverse`)
      .send({})
      .expect(401);
    await request(httpServer).get('/api/admin/users').expect(401);
    await request(httpServer)
      .patch(`/api/admin/users/${customer.userId}/status`)
      .send({ status: UserStatus.LOCKED })
      .expect(401);
    await request(httpServer).get('/api/admin/transactions').expect(401);
    await request(httpServer).get('/api/admin/audit-logs').expect(401);

    // 2. CUSTOMER có token hợp lệ nhưng gọi các cổng của ADMIN -> 403 Forbidden
    await request(httpServer)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);

    await request(httpServer)
      .patch(`/api/admin/users/${customer.userId}/status`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(403);

    await request(httpServer)
      .get('/api/admin/transactions')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);

    await request(httpServer)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);

    await request(httpServer)
      .post(`/api/transactions/${fakeUuid}/reverse`)
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Customer attempt' })
      .expect(403);
  });

  it('RB3: role is loaded fresh from DB on every request -> changing user role via SQL takes immediate effect with the exact same JWT token', async () => {
    const httpServer = app.getHttpServer();
    const user = await createAuthenticatedAccount(app, 'RB3-DynamicRole');

    // 1. Ban đầu là CUSTOMER -> gọi /api/admin/users bị từ chối 403
    await request(httpServer)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);

    // 2. Nâng role lên ADMIN bằng SQL trực tiếp trong DB
    await dataSource.query(`UPDATE "users" SET "role" = $1 WHERE "id" = $2`, [
      UserRole.ADMIN,
      user.userId,
    ]);

    // 3. Dùng lại ĐÚNG token cũ vừa bị 403 -> bây giờ được phép truy cập /api/admin/users (200 OK)!
    await request(httpServer)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    // 4. Hạ role về lại CUSTOMER bằng SQL -> cùng token đó lập tức bị chặn 403 trở lại
    await dataSource.query(`UPDATE "users" SET "role" = $1 WHERE "id" = $2`, [
      UserRole.CUSTOMER,
      user.userId,
    ]);

    await request(httpServer)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
  });

  it('RB4: ADMIN can use customer endpoints for own account, and a locked ADMIN is immediately rejected with 403 on all endpoints', async () => {
    const httpServer = app.getHttpServer();
    const admin = await createAuthenticatedAdmin(app, dataSource, 'RB4-Admin');

    // 1. ADMIN vẫn dùng được các endpoint cá nhân trên tài khoản của chính mình
    await request(httpServer)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '150000.00', description: 'Admin personal deposit' })
      .expect(201);

    const meRes = await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(meRes.body.balance).toBe('150000.00');

    // 2. Khi tài khoản ADMIN bị khóa trong DB -> cả cổng cá nhân lẫn cổng /admin/* đều trả về 403 ngay lập tức
    await dataSource.query(`UPDATE "users" SET "status" = $1 WHERE "id" = $2`, [
      UserStatus.LOCKED,
      admin.userId,
    ]);

    await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);

    await request(httpServer)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);
  });

  // =========================================================================
  // AD1 -> AD4 — KIỂM THỬ CÁC API QUẢN TRỊ (ADMIN API)
  // =========================================================================

  it('AD1: GET /admin/users supports pagination, filters by status and role, never exposes passwordHash, and rejects unknown query params with 400', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AD1-Admin');
    const cust1 = await createAuthenticatedAccount(app, 'AD1-Cust1');
    const cust2 = await createAuthenticatedAccount(app, 'AD1-Cust2');

    // Khóa cust2 để kiểm tra bộ lọc status
    await request(httpServer)
      .patch(`/api/admin/users/${cust2.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(200);

    // 1. Lấy danh sách toàn bộ người dùng -> 200, có accountNumber, tuyệt đối không có password_hash / passwordHash
    const listRes = await request(httpServer)
      .get('/api/admin/users?page=1&limit=10')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(listRes.body.meta.total).toBe(3);
    for (const item of listRes.body.data) {
      expect(item.password_hash).toBeUndefined();
      expect(item.passwordHash).toBeUndefined();
      expect(item.accountNumber).toBeDefined();
    }

    // 2. Lọc theo status = locked -> chỉ có cust2
    const lockedRes = await request(httpServer)
      .get('/api/admin/users?status=locked')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(lockedRes.body.data).toHaveLength(1);
    expect(lockedRes.body.data[0].id).toBe(cust2.userId);

    // 3. Lọc theo role = ADMIN -> chỉ có admin; lọc role = CUSTOMER -> có cust1 và cust2
    const adminRoleRes = await request(httpServer)
      .get('/api/admin/users?role=ADMIN')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(adminRoleRes.body.data).toHaveLength(1);
    expect(adminRoleRes.body.data[0].id).toBe(admin.userId);

    const custRoleRes = await request(httpServer)
      .get('/api/admin/users?role=CUSTOMER')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(custRoleRes.body.data).toHaveLength(2);
    const custIds = new Set(custRoleRes.body.data.map((u: any) => u.id));
    expect(custIds.has(cust1.userId)).toBe(true);
    expect(custIds.has(cust2.userId)).toBe(true);

    // 4. Truyền tham số lạ không nằm trong whitelist -> 400 Bad Request
    await request(httpServer)
      .get('/api/admin/users?unknownParam=123')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);
  });

  it('AD2: locking a user via PATCH /admin/users/:id/status immediately blocks both login and existing token; unlocking restores access immediately', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AD2-Admin');
    const cust = await createAuthenticatedAccount(app, 'AD2-Cust', '200000.00');

    // 1. Admin khóa tài khoản cust
    const lockRes = await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(200);
    expect(lockRes.body.status).toBe(UserStatus.LOCKED);

    // 2. Đăng nhập mới của cust bị chặn 403 VÀ token cũ đang cầm trên tay cũng bị chặn 403 ngay lập tức
    await request(httpServer)
      .post('/api/auth/login')
      .send({ email: cust.email, password: 'Password@123' })
      .expect(403);

    await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${cust.token}`)
      .expect(403);

    // 3. Admin mở khóa lại cho cust
    const unlockRes = await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.ACTIVE })
      .expect(200);
    expect(unlockRes.body.status).toBe(UserStatus.ACTIVE);

    // 4. Token cũ hoạt động trở lại ngay lập tức (200) và đăng nhập lại cũng thành công (200)
    await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${cust.token}`)
      .expect(200);

    await request(httpServer)
      .post('/api/auth/login')
      .send({ email: cust.email, password: 'Password@123' })
      .expect(200);
  });

  it('AD3: PATCH /admin/users/:id/status prevents self-lock (400), returns 404 for unknown user, rejects invalid status (400), and creates no extra audit log when status is unchanged', async () => {
    const httpServer = app.getHttpServer();
    const auditRepo = dataSource.getRepository(AuditLog);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AD3-Admin');
    const cust = await createAuthenticatedAccount(app, 'AD3-Cust');

    // 1. Admin tự khóa chính mình -> 400 Bad Request
    await request(httpServer)
      .patch(`/api/admin/users/${admin.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(400);

    // 2. User ID không tồn tại -> 404 Not Found
    await request(httpServer)
      .patch(`/api/admin/users/${randomUUID()}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(404);

    // 3. Giá trị status không hợp lệ -> 400 Bad Request
    await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'suspended_invalid' })
      .expect(400);

    // 4. Khóa cust lần 1 (active -> locked) -> tạo 1 bản ghi USER_STATUS_CHANGED
    await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(200);

    const countAfterFirstLock = await auditRepo.count({
      where: {
        action: AuditAction.USER_STATUS_CHANGED,
        entity_id: cust.userId,
      },
    });
    expect(countAfterFirstLock).toBe(1);

    // 5. Gửi tiếp status = locked khi cust ĐANG locked -> trả về 200 OK nhưng KHÔNG sinh thêm bản ghi audit
    await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(200);

    const countAfterNoOpLock = await auditRepo.count({
      where: {
        action: AuditAction.USER_STATUS_CHANGED,
        entity_id: cust.userId,
      },
    });
    expect(countAfterNoOpLock).toBe(1);
  });

  it('AD4: GET /admin/transactions filters by status, type, accountNumber, and date range, returning admin view with fromAccountNumber and toAccountNumber (including FAILED and REVERSAL)', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AD4-Admin');
    const userA = await createAuthenticatedAccount(
      app,
      'AD4-UserA',
      '500000.00',
    );
    const userB = await createAuthenticatedAccount(
      app,
      'AD4-UserB',
      '100000.00',
    );

    // 1. Tạo 1 giao dịch TRANSFER COMPLETED từ A -> B
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '120000.00',
        description: 'AD4 transfer A->B',
      })
      .expect(201);

    // 2. Tạo 1 giao dịch WITHDRAW FAILED của A (rút quá số dư)
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amount: '9999999.00',
        description: 'AD4 failed withdraw',
      })
      .expect(422);

    // 3. Admin hoàn tiền giao dịch TRANSFER -> tạo 1 giao dịch REVERSAL COMPLETED và đổi gốc sang REVERSED
    const revRes = await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'AD4 admin reversal' })
      .expect(201);

    // 4. Lọc theo status = FAILED -> thấy đúng giao dịch rút thất bại
    const failedList = await request(httpServer)
      .get('/api/admin/transactions?status=FAILED')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(failedList.body.data).toHaveLength(1);
    expect(failedList.body.data[0].fromAccountNumber).toBe(userA.accountNumber);
    expect(failedList.body.data[0].toAccountNumber).toBeNull();
    expect(failedList.body.data[0].failure_code).toBeUndefined();

    // 5. Lọc theo type = REVERSAL -> thấy giao dịch hoàn tiền từ B trả về A
    const reversalList = await request(httpServer)
      .get('/api/admin/transactions?type=REVERSAL')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(reversalList.body.data).toHaveLength(1);
    expect(reversalList.body.data[0].id).toBe(revRes.body.id);
    expect(reversalList.body.data[0].fromAccountNumber).toBe(
      userB.accountNumber,
    );
    expect(reversalList.body.data[0].toAccountNumber).toBe(userA.accountNumber);
    expect(reversalList.body.data[0].originalTransactionId).toBe(tfRes.body.id);

    // 6. Lọc theo accountNumber của B -> thấy các giao dịch mà B là người gửi hoặc người nhận
    const accBList = await request(httpServer)
      .get(`/api/admin/transactions?accountNumber=${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(accBList.body.meta.total).toBe(3); // 1 nạp khởi tạo B + 1 nhận chuyển khoản + 1 gửi hoàn tiền

    // 7. Lọc khoảng ngày không hợp lệ (fromDate > toDate) -> 400
    await request(httpServer)
      .get('/api/admin/transactions?fromDate=2026-12-31&toDate=2026-01-01')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);

    await assertLedgerInvariants(dataSource);
  });

  // =========================================================================
  // AU1 -> AU6 — KIỂM THỬ NHẬT KÝ KIỂM TOÁN TỰ ĐỘNG (AUDIT TRAIL - BÀI 3.3)
  // =========================================================================

  it('AU1 & AU2: locking and unlocking a user automatically records 2 USER_STATUS_CHANGED audit logs with exact before/after snapshots, actor, IP, and User-Agent, passing Q6 & Q7', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AU1-Admin');
    const targetUser = await createAuthenticatedAccount(app, 'AU1-Target');

    // 1. Admin khóa targetUser (active -> locked)
    await request(httpServer)
      .patch(`/api/admin/users/${targetUser.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('User-Agent', 'JestAuditAgent/1.0')
      .send({ status: UserStatus.LOCKED })
      .expect(200);

    // 2. Admin mở khóa targetUser (locked -> active)
    await request(httpServer)
      .patch(`/api/admin/users/${targetUser.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('User-Agent', 'JestAuditAgent/1.0')
      .send({ status: UserStatus.ACTIVE })
      .expect(200);

    // 3. Kiểm tra qua API GET /api/admin/audit-logs (sắp xếp ASC để xem theo trình tự thời gian)
    const auditRes = await request(httpServer)
      .get(
        `/api/admin/audit-logs?action=USER_STATUS_CHANGED&entityId=${targetUser.userId}&order=asc`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(auditRes.body.data).toHaveLength(2);

    const firstLog = auditRes.body.data[0];
    expect(firstLog.action).toBe(AuditAction.USER_STATUS_CHANGED);
    expect(firstLog.entity).toBe(AuditEntity.USERS);
    expect(firstLog.entityId).toBe(targetUser.userId);
    expect(firstLog.actor).toEqual({
      id: admin.userId,
      fullName: 'E2E User AU1-Admin',
      email: admin.email,
    });
    expect(firstLog.ipAddress).toBeTruthy();
    expect(firstLog.userAgent).toBe('JestAuditAgent/1.0');
    expect(firstLog.beforeData).toEqual({ status: UserStatus.ACTIVE });
    expect(firstLog.afterData).toEqual({ status: UserStatus.LOCKED });

    const secondLog = auditRes.body.data[1];
    expect(secondLog.beforeData).toEqual({ status: UserStatus.LOCKED });
    expect(secondLog.afterData).toEqual({ status: UserStatus.ACTIVE });

    // 4. Kiểm tra tự động Q6 (0 dòng lộ password) và Q7 (mọi dòng USER_STATUS_CHANGED đều có before/after khác nhau)
    await assertAuditInvariants(dataSource);
  });

  it('AU3: blocks UPDATE and DELETE on audit_logs via both TypeORM Repository and raw SQL (append-only trigger)', async () => {
    const auditRepo = dataSource.getRepository(AuditLog);

    // Tạo 1 user (quá trình login trong helper đã tự động sinh bản ghi AUTH_LOGIN_SUCCESS trong audit_logs)
    await createAuthenticatedAccount(app, 'AU3-User');

    const logsBefore = await auditRepo.find();
    expect(logsBefore.length).toBeGreaterThanOrEqual(1);
    const targetLog = logsBefore[0];

    // 1. Thử UPDATE qua TypeORM Repository -> bị chặn bởi trigger trg_audit_logs_immutable
    await expect(
      auditRepo.update({ id: targetLog.id }, { action: 'TAMPERED_ACTION' }),
    ).rejects.toThrow(/audit_logs is append-only/i);

    // 2. Thử DELETE qua TypeORM Repository -> bị chặn bởi trigger
    await expect(auditRepo.delete({ id: targetLog.id })).rejects.toThrow(
      /audit_logs is append-only/i,
    );

    // 3. Thử UPDATE bằng SQL thô -> bị chặn bởi trigger
    await expect(
      dataSource.query(
        `UPDATE "audit_logs" SET "action" = 'HACKED' WHERE "id" = $1`,
        [targetLog.id],
      ),
    ).rejects.toThrow(/audit_logs is append-only/i);

    // 4. Thử DELETE bằng SQL thô -> bị chặn bởi trigger
    await expect(
      dataSource.query(`DELETE FROM "audit_logs" WHERE "id" = $1`, [
        targetLog.id,
      ]),
    ).rejects.toThrow(/audit_logs is append-only/i);

    // Bản ghi vẫn nguyên vẹn 100%
    const logAfter = await auditRepo.findOneByOrFail({ id: targetLog.id });
    expect(logAfter.action).toBe(targetLog.action);
  });

  it('AU4: GET /admin/audit-logs is restricted to ADMIN (CUSTOMER gets 403, unauthenticated gets 401) and supports filtering by action, actorId, and date range', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AU4-Admin');
    const cust = await createAuthenticatedAccount(app, 'AU4-Cust');

    // Khóa cust để sinh bản ghi USER_STATUS_CHANGED do admin thực hiện
    await request(httpServer)
      .patch(`/api/admin/users/${cust.userId}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: UserStatus.LOCKED })
      .expect(200);

    // 1. Không token -> 401; CUSTOMER -> 403
    await request(httpServer).get('/api/admin/audit-logs').expect(401);

    const activeCust = await createAuthenticatedAccount(app, 'AU4-ActiveCust');
    await request(httpServer)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${activeCust.token}`)
      .expect(403);

    // 2. ADMIN lọc theo actorId = admin.userId và action = USER_STATUS_CHANGED -> 200 OK
    const filteredRes = await request(httpServer)
      .get(
        `/api/admin/audit-logs?actorId=${admin.userId}&action=USER_STATUS_CHANGED`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(filteredRes.body.data).toHaveLength(1);
    expect(filteredRes.body.data[0].entityId).toBe(cust.userId);

    // 3. Khoảng ngày không hợp lệ (fromDate > toDate) -> 400
    await request(httpServer)
      .get('/api/admin/audit-logs?fromDate=2026-12-31&toDate=2026-01-01')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);
  });

  it('AU5: AuditInterceptor records AUTH_LOGIN_SUCCESS, AUTH_LOGIN_FAILED (without password and without swallowing 401 error), and TRANSACTION_REVERSED', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'AU5-Admin');
    const userA = await createAuthenticatedAccount(
      app,
      'AU5-UserA',
      '500000.00',
    );
    const userB = await createAuthenticatedAccount(
      app,
      'AU5-UserB',
      '100000.00',
    );

    // 1. Đăng nhập sai mật khẩu -> Client vẫn nhận đúng 401 (Interceptor không nuốt lỗi)
    const wrongPassString = 'SuperSecretWrongPass@999';
    await request(httpServer)
      .post('/api/auth/login')
      .send({
        email: userA.email,
        password: wrongPassString,
      })
      .expect(401);

    // Kiểm tra bản ghi AUTH_LOGIN_FAILED: actor = null, có email đã thử, tuyệt đối không chứa wrongPassString
    const failedLoginLogs = await request(httpServer)
      .get('/api/admin/audit-logs?action=AUTH_LOGIN_FAILED')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(failedLoginLogs.body.data).toHaveLength(1);
    const failedLoginEntry = failedLoginLogs.body.data[0];
    expect(failedLoginEntry.actor).toBeNull();
    expect(failedLoginEntry.afterData.email).toBe(userA.email);
    expect(failedLoginEntry.afterData.outcome).toBe('ERROR');
    expect(failedLoginEntry.afterData.httpStatus).toBe(401);
    expect(JSON.stringify(failedLoginEntry)).not.toContain(wrongPassString);

    // 2. Tạo 1 giao dịch chuyển khoản rồi Admin hoàn tiền -> ghi nhận TRANSACTION_REVERSED
    const tfRes = await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '50000.00',
        description: 'AU5 transfer to reverse',
      })
      .expect(201);

    const revRes = await request(httpServer)
      .post(`/api/transactions/${tfRes.body.id}/reverse`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'AU5 reversal audit test' })
      .expect(201);

    const reversalLogs = await request(httpServer)
      .get(
        `/api/admin/audit-logs?action=TRANSACTION_REVERSED&entityId=${tfRes.body.id}`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(reversalLogs.body.data).toHaveLength(1);
    expect(reversalLogs.body.data[0].actor.id).toBe(admin.userId);
    expect(reversalLogs.body.data[0].afterData).toMatchObject({
      originalTransactionId: tfRes.body.id,
      reversalTransactionId: revRes.body.id,
      outcome: 'SUCCESS',
      httpStatus: 201,
    });

    await assertAuditInvariants(dataSource);
    await assertLedgerInvariants(dataSource);
  });

  it('AU6: transactional atomicity -> when a transaction updating User fails after manager.save(User) and rolls back, the Subscriber audit log is also rolled back completely', async () => {
    const userRepo = dataSource.getRepository(User);
    const auditRepo = dataSource.getRepository(AuditLog);

    const target = await createAuthenticatedAccount(app, 'AU6-RollbackUser');

    const auditCountBefore = await auditRepo.count({
      where: {
        action: AuditAction.USER_STATUS_CHANGED,
        entity_id: target.userId,
      },
    });
    expect(auditCountBefore).toBe(0);

    // Thực hiện cập nhật User bằng manager.save(User, user) bên trong một transaction
    // (lúc này UserAuditSubscriber.afterUpdate đã chạy và chèn dòng audit qua event.manager),
    // sau đó ném lỗi ngay trước khi commit để ép transaction rollback!
    await expect(
      dataSource.transaction(async (manager) => {
        const userInTx = await manager.findOneByOrFail(User, {
          id: target.userId,
        });
        userInTx.status = UserStatus.LOCKED;
        await manager.save(User, userInTx);

        throw new Error(
          'Simulated failure after manager.save(User) to verify audit rollback',
        );
      }),
    ).rejects.toThrow(/Simulated failure after manager\.save/);

    // 1. Trạng thái của người dùng trong DB vẫn giữ nguyên là ACTIVE
    const userAfter = await userRepo.findOneByOrFail({ id: target.userId });
    expect(userAfter.status).toBe(UserStatus.ACTIVE);

    // 2. Bản ghi audit do Subscriber chèn qua event.manager cũng đã được rollback hoàn toàn (0 bản ghi)!
    const auditCountAfter = await auditRepo.count({
      where: {
        action: AuditAction.USER_STATUS_CHANGED,
        entity_id: target.userId,
      },
    });
    expect(auditCountAfter).toBe(0);

    await assertAuditInvariants(dataSource);
  });
});
