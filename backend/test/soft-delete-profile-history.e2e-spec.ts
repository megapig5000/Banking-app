import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { User } from '../src/database/entities/user.entity';
import {
  Account,
  AccountStatus,
} from '../src/database/entities/account.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/database/entities/transaction.entity';
import { AccountHistory } from '../src/database/entities/account-history.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { AuditAction } from '../src/audit/audit.constants';
import { TransactionFailureCode } from '../src/transactions/transactions.constants';
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

describe('Module 5 (3.4) — Soft Delete & Versioned Profile History (e2e)', () => {
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
  // BÀI 3.4 (PHẦN 1) — XÓA MỀM USER & ACCOUNT (S1 -> S5)
  // =========================================================================

  it('S1: soft deleting a 0-balance customer keeps DB rows (deleted_at set, account CLOSED), hides from default admin list, shows with includeDeleted=true, revokes login & existing token (401), returns 404 on transfer/lookup, and preserves counterpartyAccountNumber in partner history', async () => {
    const httpServer = app.getHttpServer();
    const userRepo = dataSource.getRepository(User);
    const accRepo = dataSource.getRepository(Account);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'S1-Admin');
    const partner = await createAuthenticatedAccount(
      app,
      'S1-Partner',
      '500000.00',
    );
    const target = await createAuthenticatedAccount(app, 'S1-Target', '0.00');

    // 1. Partner chuyển 50,000.00 cho Target, sau đó Target rút hết 50,000.00 để số dư về 0.00
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${partner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: target.accountNumber,
        amount: '50000.00',
        description: 'S1 transfer to target before soft delete',
      })
      .expect(201);

    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${target.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '50000.00', description: 'S1 target empties balance' })
      .expect(201);

    // 2. Admin xóa mềm Target -> 204 No Content
    await request(httpServer)
      .delete(`/api/admin/users/${target.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    // 3. Bản ghi trong bảng users và accounts vẫn còn trong DB (khi đọc với withDeleted: true), deleted_at != null, account CLOSED
    const dbUser = await userRepo.findOne({
      where: { id: target.userId },
      withDeleted: true,
    });
    const dbAcc = await accRepo.findOne({
      where: { id: target.accountId },
      withDeleted: true,
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.deleted_at).not.toBeNull();
    expect(dbAcc).not.toBeNull();
    expect(dbAcc!.deleted_at).not.toBeNull();
    expect(dbAcc!.status).toBe(AccountStatus.CLOSED);

    // 4. Không xuất hiện ở GET /api/admin/users mặc định, nhưng xuất hiện khi includeDeleted=true
    const defaultList = await request(httpServer)
      .get('/api/admin/users?limit=100')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(defaultList.body.data.some((u: any) => u.id === target.userId)).toBe(
      false,
    );

    const inclDeletedList = await request(httpServer)
      .get('/api/admin/users?limit=100&includeDeleted=true')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const deletedItem = inclDeletedList.body.data.find(
      (u: any) => u.id === target.userId,
    );
    expect(deletedItem).toBeDefined();
    expect(deletedItem.deletedAt).toBeTruthy();
    expect(deletedItem.accountStatus).toBe(AccountStatus.CLOSED);

    // 5. Đăng nhập -> 401; Token cũ (cấp trước khi xóa) -> 401 ngay ở request kế tiếp
    await request(httpServer)
      .post('/api/auth/login')
      .send({ email: target.email, password: 'Password@123' })
      .expect(401);

    await request(httpServer)
      .get('/api/accounts/me')
      .set('Authorization', `Bearer ${target.token}`)
      .expect(401);

    // 6. Chuyển tiền tới số tài khoản đã xóa -> 404; Admin tra cứu GET /api/accounts/:accountNumber -> 404
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${partner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: target.accountNumber,
        amount: '10000.00',
        description: 'S1 transfer to deleted account',
      })
      .expect(404);

    await request(httpServer)
      .get(`/api/accounts/${target.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);

    // 7. Lịch sử giao dịch của Partner (và của Admin) vẫn thấy nguyên vẹn counterpartyAccountNumber của Target đã xóa!
    const partnerHistory = await request(httpServer)
      .get('/api/transactions?page=1&limit=10')
      .set('Authorization', `Bearer ${partner.token}`)
      .expect(200);

    const txWithDeletedPartner = partnerHistory.body.data.find(
      (t: any) => t.description === 'S1 transfer to target before soft delete',
    );
    expect(txWithDeletedPartner).toBeDefined();
    expect(txWithDeletedPartner.counterpartyAccountNumber).toBe(
      target.accountNumber,
    );

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('S2: DELETE /admin/users/:id rejects when balance > 0, hold > 0, or pending tx exists (409); blocks self-delete (400), deleting ADMIN (403), non-admin caller (403), and unknown/already-deleted user (404)', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin1 = await createAuthenticatedAdmin(app, dataSource, 'S2-Admin1');
    const admin2 = await createAuthenticatedAdmin(app, dataSource, 'S2-Admin2');
    const custWithBal = await createAuthenticatedAccount(
      app,
      'S2-CustBal',
      '100000.00',
    );

    // 1. CUSTOMER gọi DELETE /api/admin/users/:id -> 403 Forbidden
    await request(httpServer)
      .delete(`/api/admin/users/${custWithBal.userId}`)
      .set('Authorization', `Bearer ${custWithBal.token}`)
      .expect(403);

    // 2. Admin tự xóa chính mình -> 400 Bad Request
    await request(httpServer)
      .delete(`/api/admin/users/${admin1.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(400);

    // 3. Admin xóa một tài khoản ADMIN khác -> 403 Forbidden
    await request(httpServer)
      .delete(`/api/admin/users/${admin2.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(403);

    // 4. Xóa user không tồn tại -> 404 Not Found
    await request(httpServer)
      .delete(`/api/admin/users/${randomUUID()}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(404);

    // 5. Xóa user khi vẫn còn balance > 0 (100,000.00) -> 409 Conflict
    await request(httpServer)
      .delete(`/api/admin/users/${custWithBal.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(409);

    // Rút hết 100,000.00 nhưng có giao dịch đang PROCESSING -> 409 Conflict
    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${custWithBal.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '100000.00', description: 'S2 empty balance' })
      .expect(201);

    const pendingTx = await txRepo.save(
      txRepo.create({
        actor_account_id: custWithBal.accountId,
        from_account_id: custWithBal.accountId,
        to_account_id: null,
        amount: '10000.00',
        type: TransactionType.WITHDRAW,
        status: TransactionStatus.PROCESSING,
        description: 'S2 pending tx',
      }),
    );

    await request(httpServer)
      .delete(`/api/admin/users/${custWithBal.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(409);

    // Đánh dấu giao dịch treo sang FAILED rồi xóa mềm -> 204 No Content
    await txRepo.update(
      { id: pendingTx.id },
      {
        status: TransactionStatus.FAILED,
        failure_code: TransactionFailureCode.TIMEOUT,
      },
    );

    await request(httpServer)
      .delete(`/api/admin/users/${custWithBal.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(204);

    // 6. Thử xóa lại user vừa bị xóa mềm -> 404 Not Found
    await request(httpServer)
      .delete(`/api/admin/users/${custWithBal.userId}`)
      .set('Authorization', `Bearer ${admin1.token}`)
      .expect(404);

    await assertLedgerInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('S3: registering a new account with the email of a soft-deleted user is rejected with 409 Conflict', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'S3-Admin');
    const target = await createAuthenticatedAccount(app, 'S3-Target', '0.00');

    await request(httpServer)
      .delete(`/api/admin/users/${target.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    // Đăng ký lại bằng đúng email đã bị xóa mềm -> 409 Conflict (không phải 500!)
    const reregRes = await request(httpServer)
      .post('/api/auth/register')
      .send({
        fullName: 'S3 Re-register Attempt',
        email: target.email,
        password: 'Password@123',
      })
      .expect(409);

    expect(reregRes.body.message).toMatch(/Email đã tồn tại/i);
  });

  it('S4: soft delete preserves all ledger entries and transactions intact, passing Q1-Q5 and Q8-Q10 invariants', async () => {
    const httpServer = app.getHttpServer();
    const txRepo = dataSource.getRepository(Transaction);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'S4-Admin');
    const userA = await createAuthenticatedAccount(app, 'S4-A', '300000.00');
    const userB = await createAuthenticatedAccount(app, 'S4-B', '100000.00');

    // User A chuyển 100,000.00 cho User B, sau đó User B rút hết 200,000.00 về 0.00
    await request(httpServer)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        toAccountNumber: userB.accountNumber,
        amount: '100000.00',
        description: 'S4 transfer A->B',
      })
      .expect(201);

    await request(httpServer)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '200000.00', description: 'S4 B withdraws all' })
      .expect(201);

    const txCountBeforeDelete = await txRepo.count();

    // Xóa mềm User B
    await request(httpServer)
      .delete(`/api/admin/users/${userB.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    // Số lượng giao dịch không đổi, Admin xem /api/admin/transactions vẫn thấy đầy đủ số tài khoản của B
    expect(await txRepo.count()).toBe(txCountBeforeDelete);

    const adminTxRes = await request(httpServer)
      .get(`/api/admin/transactions?accountNumber=${userB.accountNumber}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(adminTxRes.body.meta.total).toBe(3);

    await assertLedgerInvariants(dataSource);
    await assertAuditInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  it('S5: soft delete records USER_SOFT_DELETED audit log in the same transaction; mid-transaction failure rolls back account closure, soft delete, and audit logs completely', async () => {
    const httpServer = app.getHttpServer();
    const auditRepo = dataSource.getRepository(AuditLog);
    const accRepo = dataSource.getRepository(Account);
    const userRepo = dataSource.getRepository(User);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'S5-Admin');
    const user1 = await createAuthenticatedAccount(app, 'S5-User1', '0.00');
    const user2 = await createAuthenticatedAccount(app, 'S5-User2', '0.00');

    // 1. Xóa mềm thành công user1 -> có đúng 1 bản ghi USER_SOFT_DELETED
    await request(httpServer)
      .delete(`/api/admin/users/${user1.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(204);

    const softDeleteLogs = await auditRepo.find({
      where: {
        action: AuditAction.USER_SOFT_DELETED,
        entity_id: user1.userId,
      },
    });
    expect(softDeleteLogs).toHaveLength(1);
    expect(softDeleteLogs[0].actor_id).toBe(admin.userId);
    expect(softDeleteLogs[0].before_data).toMatchObject({
      email: user1.email,
      status: 'active',
    });
    expect(softDeleteLogs[0].after_data?.deletedAt).toBeTruthy();

    // 2. Giả lập lỗi giữa chừng khi xóa mềm user2 (sau khi đã đóng & xóa mềm Account, ném lỗi lúc xóa mềm User)
    const origSoftRemove = Object.getOwnPropertyDescriptor(
      EntityManager.prototype,
      'softRemove',
    )!.value as typeof EntityManager.prototype.softRemove;
    jest
      .spyOn(EntityManager.prototype, 'softRemove')
      .mockImplementation(async function (
        this: EntityManager,
        targetOrEntity: any,
        maybeEntity?: any,
      ) {
        if (targetOrEntity === User || targetOrEntity instanceof User) {
          throw new Error(
            'Simulated failure during manager.softRemove(User) to verify atomic rollback',
          );
        }
        return origSoftRemove.call(this, targetOrEntity, maybeEntity);
      });

    await request(httpServer)
      .delete(`/api/admin/users/${user2.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(500);

    jest.restoreAllMocks();

    // Cả Account lẫn User của user2 đều phải được rollback về trạng thái chưa xóa (ACTIVE, deleted_at = null),
    // và không có bản ghi USER_SOFT_DELETED hay ACCOUNT_UPDATED mồ côi nào được lưu cho user2!
    const acc2After = await accRepo.findOneByOrFail({ id: user2.accountId });
    const user2After = await userRepo.findOneByOrFail({ id: user2.userId });
    expect(acc2After.status).toBe(AccountStatus.ACTIVE);
    expect(acc2After.deleted_at).toBeNull();
    expect(user2After.deleted_at).toBeNull();

    const user2SoftDeleteAuditCount = await auditRepo.count({
      where: {
        action: AuditAction.USER_SOFT_DELETED,
        entity_id: user2.userId,
      },
    });
    const acc2AuditCount = await auditRepo.count({
      where: {
        action: AuditAction.ACCOUNT_UPDATED,
        entity_id: user2.accountId,
      },
    });
    expect(user2SoftDeleteAuditCount).toBe(0);
    expect(acc2AuditCount).toBe(0);

    await assertAuditInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });

  // =========================================================================
  // BÀI 3.4 (PHẦN 2) — CẬP NHẬT HỒ SƠ & LỊCH SỬ PHIÊN BẢN ACCOUNT_HISTORY (H1 -> H5)
  // =========================================================================

  it('H1: updating phone twice inserts 2 old snapshots in account_history (versions 1 and 2), increments profileVersion to 3, returns newest-first in GET /users/me/profile-history, and skips history on no-op update', async () => {
    const httpServer = app.getHttpServer();

    const user = await createAuthenticatedAccount(app, 'H1-User');

    // 1. Lần sửa 1: đổi phone từ null -> '0901234567' (profileVersion: 1 -> 2, lưu v1 phone=null)
    const patch1 = await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phone: '0901234567' })
      .expect(200);

    expect(patch1.body.phone).toBe('0901234567');
    expect(patch1.body.profileVersion).toBe(2);

    // 2. Lần sửa 2: đổi phone từ '0901234567' -> '0987654321' (profileVersion: 2 -> 3, lưu v2 phone='0901234567')
    const patch2 = await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phone: '0987654321' })
      .expect(200);

    expect(patch2.body.phone).toBe('0987654321');
    expect(patch2.body.profileVersion).toBe(3);

    // 3. Gửi lại cùng phone = '0987654321' (không có gì thay đổi) -> profileVersion vẫn = 3, không thêm dòng lịch sử
    const noOpPatch = await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phone: '0987654321' })
      .expect(200);

    expect(noOpPatch.body.profileVersion).toBe(3);

    // 4. Kiểm tra GET /api/users/me/profile-history -> đúng 2 dòng, mới nhất trước (v2 rồi v1)
    const historyRes = await request(httpServer)
      .get('/api/users/me/profile-history?page=1&limit=10')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    expect(historyRes.body.meta.total).toBe(2);
    expect(historyRes.body.data).toHaveLength(2);

    expect(historyRes.body.data[0]).toMatchObject({
      version: 2,
      email: user.email,
      phone: '0901234567',
      changedByUserId: user.userId,
    });
    expect(historyRes.body.data[1]).toMatchObject({
      version: 1,
      email: user.email,
      phone: null,
      changedByUserId: user.userId,
    });
  });

  it('H2: changing email requires valid currentPassword (missing/wrong returns 400 without modifying profile or history), duplicate email returns 409, invalid phone format returns 400, and unknown field returns 400', async () => {
    const httpServer = app.getHttpServer();
    const historyRepo = dataSource.getRepository(AccountHistory);

    const user1 = await createAuthenticatedAccount(app, 'H2-User1');
    const user2 = await createAuthenticatedAccount(app, 'H2-User2');

    // 1. Đổi email nhưng thiếu currentPassword -> 400 Bad Request
    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ email: 'new-h2@bank.local' })
      .expect(400);

    // 2. Đổi email nhưng sai currentPassword -> 400 Bad Request (không phải 401!)
    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({
        email: 'new-h2@bank.local',
        currentPassword: 'WrongPassword@999',
      })
      .expect(400);

    // Không có dòng lịch sử nào được tạo sau các lần lỗi
    expect(await historyRepo.count({ where: { user_id: user1.userId } })).toBe(
      0,
    );

    // 3. Đổi email sang email đã tồn tại của user2 -> 409 Conflict
    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({
        email: user2.email,
        currentPassword: 'Password@123',
      })
      .expect(409);

    // 4. Số điện thoại sai định dạng Việt Nam -> 400 Bad Request
    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ phone: '12345-invalid' })
      .expect(400);

    // 5. Truyền trường lạ không nằm trong whitelist (ví dụ role: 'ADMIN') -> 400 Bad Request
    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({ fullName: 'Valid Name', role: 'ADMIN' })
      .expect(400);

    // 6. Đổi email hợp lệ kèm đúng currentPassword -> 200 OK
    const validEmailRes = await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user1.token}`)
      .send({
        email: 'valid-new-h2@bank.local',
        currentPassword: 'Password@123',
      })
      .expect(200);

    expect(validEmailRes.body.email).toBe('valid-new-h2@bank.local');
    expect(validEmailRes.body.profileVersion).toBe(2);
  });

  it('H3: transactional atomicity -> when an error occurs after inserting account_history and before saving User, both profile and account_history roll back completely', async () => {
    const httpServer = app.getHttpServer();
    const userRepo = dataSource.getRepository(User);
    const historyRepo = dataSource.getRepository(AccountHistory);

    const user = await createAuthenticatedAccount(app, 'H3-User');

    // Giả lập lỗi ngay tại manager.save(User, user) sau khi insertProfileHistoryBeforeOverwrite đã chèn dòng vào account_history
    const origSave = Object.getOwnPropertyDescriptor(
      EntityManager.prototype,
      'save',
    )!.value as typeof EntityManager.prototype.save;
    jest
      .spyOn(EntityManager.prototype, 'save')
      .mockImplementationOnce(async function (
        this: EntityManager,
        targetOrEntity: any,
        maybeEntity?: any,
      ) {
        if (targetOrEntity === User) {
          throw new Error(
            'Simulated DB crash right after inserting account_history',
          );
        }
        return origSave.call(this, targetOrEntity, maybeEntity);
      });

    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ phone: '0911223344' })
      .expect(500);

    const userAfter = await userRepo.findOneByOrFail({ id: user.userId });
    expect(userAfter.phone).toBeNull();
    expect(userAfter.profile_version).toBe(1);

    const historyCount = await historyRepo.count({
      where: { user_id: user.userId },
    });
    expect(historyCount).toBe(0);
  });

  it('H4: CUSTOMER cannot view another user profile history (403), ADMIN can view any user history (200), and account_history is append-only (blocks UPDATE and DELETE via trigger)', async () => {
    const httpServer = app.getHttpServer();
    const historyRepo = dataSource.getRepository(AccountHistory);

    const admin = await createAuthenticatedAdmin(app, dataSource, 'H4-Admin');
    const userA = await createAuthenticatedAccount(app, 'H4-UserA');
    const userB = await createAuthenticatedAccount(app, 'H4-UserB');

    await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ phone: '0909998887' })
      .expect(200);

    // 1. User B thử xem lịch sử hồ sơ của User A qua endpoint Admin -> 403 Forbidden
    await request(httpServer)
      .get(`/api/admin/users/${userA.userId}/profile-history`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(403);

    // 2. Admin xem lịch sử hồ sơ của User A -> 200 OK
    const adminViewRes = await request(httpServer)
      .get(`/api/admin/users/${userA.userId}/profile-history`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(adminViewRes.body.data).toHaveLength(1);
    expect(adminViewRes.body.data[0].version).toBe(1);

    // 3. Thử UPDATE và DELETE trên bảng account_history qua cả TypeORM Repository và SQL thô -> bị chặn bởi trigger trg_account_history_immutable
    const historyRow = await historyRepo.findOneByOrFail({
      user_id: userA.userId,
      version: 1,
    });

    await expect(
      historyRepo.update({ id: historyRow.id }, { full_name: 'Hacked Name' }),
    ).rejects.toThrow(/account_history is append-only/i);

    await expect(historyRepo.delete({ id: historyRow.id })).rejects.toThrow(
      /account_history is append-only/i,
    );

    await expect(
      dataSource.query(
        `UPDATE "account_history" SET "full_name" = 'SQL Hacked' WHERE "id" = $1`,
        [historyRow.id],
      ),
    ).rejects.toThrow(/account_history is append-only/i);

    await expect(
      dataSource.query(`DELETE FROM "account_history" WHERE "id" = $1`, [
        historyRow.id,
      ]),
    ).rejects.toThrow(/account_history is append-only/i);
  });

  it('H5: updating profile records USER_UPDATED audit log with exact before/after diff, sanitizes HTML in fullName, and never exposes password (passes Q6 & Q7)', async () => {
    const httpServer = app.getHttpServer();

    const admin = await createAuthenticatedAdmin(app, dataSource, 'H5-Admin');
    const user = await createAuthenticatedAccount(app, 'H5-User');

    // Cập nhật fullName có chứa thẻ HTML và thêm phone
    const patchRes = await request(httpServer)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        fullName: 'Nguyen <script>alert(1)</script> Van B',
        phone: '+84912345678',
      })
      .expect(200);

    expect(patchRes.body.fullName).toBe(
      'Nguyen &lt;script&gt;alert(1)&lt;/script&gt; Van B',
    );
    expect(patchRes.body.phone).toBe('+84912345678');

    // Kiểm tra bản ghi USER_UPDATED trong audit_logs
    const auditRes = await request(httpServer)
      .get(
        `/api/admin/audit-logs?action=${AuditAction.USER_UPDATED}&entityId=${user.userId}`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    expect(auditRes.body.data).toHaveLength(1);
    const logEntry = auditRes.body.data[0];
    expect(logEntry.actor.id).toBe(user.userId);
    expect(logEntry.beforeData).toEqual({
      fullName: 'E2E User H5-User',
      phone: null,
    });
    expect(logEntry.afterData).toEqual({
      fullName: 'Nguyen &lt;script&gt;alert(1)&lt;/script&gt; Van B',
      phone: '+84912345678',
    });

    await assertAuditInvariants(dataSource);
    await assertModule5Invariants(dataSource);
  });
});
