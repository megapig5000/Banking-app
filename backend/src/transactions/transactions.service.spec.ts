import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import {
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../database/entities/transaction.entity';
import {
  LedgerEntry,
  LedgerEntryType,
} from '../database/entities/ledger-entry.entity';
import { IdempotencyKeyStatus } from '../database/entities/idempotency-key.entity';
import { UserStatus } from '../database/entities/user.entity';
import {
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_NUMERIC_OVERFLOW,
  PG_QUERY_CANCELED,
  PG_UNIQUE_VIOLATION,
  TransactionFailureCode,
} from './transactions.constants';
import { SortOrder, TransactionDirection } from './dto/transaction-query.dto';
import {
  buildMockAccount,
  buildMockIdempotencyKey,
  buildMockTransaction,
  buildMockUser,
  createMockEntityManager,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockRepository,
} from '../test-utils/mock-helpers';

describe('TransactionsService — Unit Test Toàn diện (Luồng 3 Pha, Hạn mức, Trạng thái TK, Khả dụng, Deadlock & Hoàn tiền)', () => {
  let service: TransactionsService;
  let txRepo: ReturnType<typeof createMockRepository>;
  let accountRepo: ReturnType<typeof createMockRepository>;
  let mockDataSource: {
    createQueryRunner: jest.Mock;
    query: jest.Mock;
    transaction: jest.Mock;
  };
  let mockIdempotencyService: {
    computeRequestHash: jest.Mock;
    normalizeDecimalAmount: jest.Mock;
    beginIdempotency: jest.Mock;
    attachTransactionId: jest.Mock;
    completeInTransaction: jest.Mock;
    failInTransaction: jest.Mock;
    failStuckKeyByTransactionId: jest.Mock;
  };

  const VALID_KEY = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    txRepo = createMockRepository();
    accountRepo = createMockRepository();
    mockDataSource = {
      createQueryRunner: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (cb: any) => cb(createMockEntityManager())),
    };
    mockIdempotencyService = {
      computeRequestHash: jest.fn().mockReturnValue('a'.repeat(64)),
      normalizeDecimalAmount: jest.fn((val: string) =>
        val.includes('.') ? val : `${val}.00`,
      ),
      beginIdempotency: jest.fn(),
      attachTransactionId: jest.fn().mockResolvedValue(undefined),
      completeInTransaction: jest.fn().mockResolvedValue(undefined),
      failInTransaction: jest.fn().mockResolvedValue(undefined),
      failStuckKeyByTransactionId: jest.fn().mockResolvedValue(undefined),
    };

    service = new TransactionsService(
      txRepo as any,
      accountRepo as any,
      mockDataSource as any,
      mockIdempotencyService as any,
    );
  });

  /**
   * Helper thiết lập nhanh QueryRunner cho Pha A (tạo phiếu thành công) và Pha C (ghi nhận FAILED)
   * để tập trung kiểm thử các nhánh quyết định trong Pha B.
   */
  function setupPhaseAAndPhaseCRunners(
    phaseBRunners: Array<ReturnType<typeof createMockQueryRunner>>,
    senderAcc = buildMockAccount({
      id: 'acc-sender',
      user_id: 'user-sender',
      account_number: '1000000001',
    }),
    receiverAcc = buildMockAccount({
      id: 'acc-receiver',
      user_id: 'user-receiver',
      account_number: '1000000002',
    }),
  ) {
    const qrPhaseA = createMockQueryRunner();
    qrPhaseA.manager.findOne
      .mockResolvedValueOnce(senderAcc)
      .mockResolvedValueOnce(receiverAcc);

    mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
      isNew: true,
      record: buildMockIdempotencyKey({ id: 'idem-rec-test' }),
    });

    const qrPhaseC = createMockQueryRunner();

    mockDataSource.createQueryRunner.mockReturnValueOnce(qrPhaseA);
    for (const qrB of phaseBRunners) {
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrB);
    }
    mockDataSource.createQueryRunner.mockReturnValueOnce(qrPhaseC);

    return { qrPhaseA, qrPhaseC };
  }

  // =========================================================================
  // 1. STATE MACHINE (transition) & DEADLOCK STATS
  // =========================================================================

  describe('getDeadlockStats & transition (State Machine)', () => {
    it('getDeadlockStats trả về bản sao bộ đếm deadlock ban đầu bằng 0', () => {
      expect(service.getDeadlockStats()).toEqual({
        deadlockDetected: 0,
        retrySucceeded: 0,
        retryExhausted: 0,
      });
    });

    it('transition từ chối cạnh chuyển trạng thái không hợp lệ (FAILED -> COMPLETED) với 409 ConflictException', async () => {
      const manager = createMockEntityManager();

      await expect(
        service.transition(
          manager as any,
          'tx-1',
          TransactionStatus.FAILED,
          TransactionStatus.COMPLETED,
        ),
      ).rejects.toThrow(ConflictException);

      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('transition ném 409 ConflictException khi câu lệnh UPDATE có điều kiện trả về affected = 0', async () => {
      const qb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValueOnce({ affected: 0 }),
      });
      const manager = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qb),
      });

      await expect(
        service.transition(
          manager as any,
          'tx-1',
          TransactionStatus.PROCESSING,
          TransactionStatus.COMPLETED,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('transition cập nhật thành công status và failure_code khi cạnh hợp lệ và affected = 1', async () => {
      const qb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValueOnce({ affected: 1 }),
      });
      const manager = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qb),
      });

      await service.transition(
        manager as any,
        'tx-1',
        TransactionStatus.PROCESSING,
        TransactionStatus.FAILED,
        { failureCode: TransactionFailureCode.INSUFFICIENT_BALANCE },
      );

      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TransactionStatus.FAILED,
          failure_code: TransactionFailureCode.INSUFFICIENT_BALANCE,
        }),
      );
      expect(qb.where).toHaveBeenCalledWith('id = :id AND status = :from', {
        id: 'tx-1',
        from: TransactionStatus.PROCESSING,
      });
    });
  });

  // =========================================================================
  // 2. LỊCH SỬ GIAO DỊCH (getTransactions)
  // =========================================================================

  describe('getTransactions (Lịch sử giao dịch cá nhân)', () => {
    it('ném 400 BadRequestException khi fromDate > toDate và ném 404 khi không tìm thấy tài khoản', async () => {
      await expect(
        service.getTransactions('user-1', {
          fromDate: '2026-12-31',
          toDate: '2026-01-01',
        }),
      ).rejects.toThrow(BadRequestException);

      accountRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getTransactions('user-1', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lọc đúng theo direction (INCOMING, OUTGOING, mặc định), khoảng ngày và gắn reversalTransactionId cho giao dịch REVERSED', async () => {
      const myAccount = buildMockAccount({
        id: 'acc-me',
        account_number: '1000000001',
      });
      const partnerAccount = buildMockAccount({
        id: 'acc-partner',
        account_number: '1000000002',
      });

      accountRepo.findOne.mockResolvedValue(myAccount);

      const reversedTx = buildMockTransaction({
        id: 'tx-reversed-1',
        from_account_id: myAccount.id,
        to_account_id: partnerAccount.id,
        fromAccount: myAccount,
        toAccount: partnerAccount,
        status: TransactionStatus.REVERSED,
        amount: '150000.00',
      });

      const incomingTx = buildMockTransaction({
        id: 'tx-in-2',
        from_account_id: partnerAccount.id,
        to_account_id: myAccount.id,
        fromAccount: partnerAccount,
        toAccount: myAccount,
        status: TransactionStatus.COMPLETED,
        amount: '50000.00',
      });

      txRepo.queryBuilder.getManyAndCount.mockResolvedValue([
        [reversedTx, incomingTx],
        2,
      ]);
      txRepo.find.mockResolvedValueOnce([
        {
          id: 'tx-rev-child-99',
          original_transaction_id: 'tx-reversed-1',
        },
      ]);

      const res = await service.getTransactions('user-1', {
        page: 1,
        limit: 10,
        direction: TransactionDirection.INCOMING,
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
        order: SortOrder.ASC,
      });

      expect(txRepo.queryBuilder.withDeleted).toHaveBeenCalled();
      expect(res.meta).toEqual({
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
      });
      expect(res.data[0]).toMatchObject({
        id: 'tx-reversed-1',
        direction: 'outgoing',
        counterpartyAccountNumber: '1000000002',
        reversalTransactionId: 'tx-rev-child-99',
      });
      expect(res.data[1]).toMatchObject({
        id: 'tx-in-2',
        direction: 'incoming',
        counterpartyAccountNumber: '1000000002',
        reversalTransactionId: null,
      });

      txRepo.find.mockResolvedValue([]);
      await service.getTransactions('user-1', {
        direction: TransactionDirection.OUTGOING,
      });
      await service.getTransactions('user-1', {});
      expect(txRepo.queryBuilder.andWhere).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. PHA A & REPLAY IDEMPOTENCY
  // =========================================================================

  describe('Pha A — Kiểm tra đầu vào & Replay Idempotency', () => {
    it('từ chối ngay với 400 BadRequestException khi amount <= 0 ("0", "0.00", "-10") mà chưa mở transaction', async () => {
      await expect(
        service.transfer('user-1', VALID_KEY, {
          toAccountNumber: '1000000002',
          amount: '0.00',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.deposit('user-1', VALID_KEY, { amount: '0' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.withdraw('user-1', VALID_KEY, { amount: '-50.00' }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('Pha A: ném 404 khi không tìm thấy tài khoản nguồn và ném 403 khi chủ tài khoản nguồn bị locked', async () => {
      const qr1 = createMockQueryRunner();
      qr1.manager.findOne.mockResolvedValueOnce(null);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr1);

      await expect(
        service.deposit('user-missing', VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow(NotFoundException);
      expect(qr1.rollbackTransaction).toHaveBeenCalledTimes(1);

      const lockedUser = buildMockUser({ status: UserStatus.LOCKED });
      const lockedAcc = buildMockAccount({ user: lockedUser });
      const qr2 = createMockQueryRunner();
      qr2.manager.findOne.mockResolvedValueOnce(lockedAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr2);

      await expect(
        service.deposit(lockedUser.id, VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow(ForbiddenException);
      expect(qr2.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it('Pha A của transfer: ném 404 khi tài khoản đích không tồn tại và ném 400 khi tự chuyển cho chính mình', async () => {
      const actorAcc = buildMockAccount({
        id: 'acc-1',
        account_number: '1000000001',
      });

      const qrNotFound = createMockQueryRunner();
      qrNotFound.manager.findOne
        .mockResolvedValueOnce(actorAcc)
        .mockResolvedValueOnce(null);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrNotFound);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.transfer('user-1', VALID_KEY, {
          toAccountNumber: '9999999999',
          amount: '50000.00',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(qrNotFound.rollbackTransaction).toHaveBeenCalledTimes(1);

      const qrSelf = createMockQueryRunner();
      qrSelf.manager.findOne
        .mockResolvedValueOnce(actorAcc)
        .mockResolvedValueOnce(actorAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrSelf);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.transfer('user-1', VALID_KEY, {
          toAccountNumber: '1000000001',
          amount: '50000.00',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(qrSelf.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it('Replay Idempotency ở Pha A: trả 200 OK cho COMPLETED, ném lại lỗi đã lưu cho FAILED, và trả 202 Accepted cho IN_PROGRESS (cả khi có và chưa có existingTx)', async () => {
      const actorAcc = buildMockAccount({ id: 'acc-1' });

      // 1. Khóa COMPLETED -> 200 OK
      const qrCompleted = createMockQueryRunner();
      qrCompleted.manager.findOne.mockResolvedValueOnce(actorAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrCompleted);
      const savedSnapshot = {
        id: 'tx-done-1',
        status: TransactionStatus.COMPLETED,
        amount: '100000.00',
      };
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: false,
        record: buildMockIdempotencyKey({
          status: IdempotencyKeyStatus.COMPLETED,
          response_status: 201,
          response_body: savedSnapshot,
        }),
      });

      const replayCompleted = await service.deposit('user-1', VALID_KEY, {
        amount: '100000.00',
      });
      expect(replayCompleted).toEqual({
        statusCode: HttpStatus.OK,
        transaction: savedSnapshot,
      });

      // 2. Khóa FAILED -> ném lại HttpException
      const qrFailed = createMockQueryRunner();
      qrFailed.manager.findOne.mockResolvedValueOnce(actorAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrFailed);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: false,
        record: buildMockIdempotencyKey({
          status: IdempotencyKeyStatus.FAILED,
          response_status: HttpStatus.UNPROCESSABLE_ENTITY,
          response_body: {
            statusCode: 422,
            message: 'Không đủ số dư khả dụng',
            error: 'Unprocessable Entity',
          },
        }),
      });

      await expect(
        service.withdraw('user-1', VALID_KEY, { amount: '999999.00' }),
      ).rejects.toThrow(HttpException);

      // 3. Khóa IN_PROGRESS có existingTx -> 202 Accepted
      const qrInProgress = createMockQueryRunner();
      const inFlightTx = buildMockTransaction({
        id: 'tx-inflight-1',
        status: TransactionStatus.PROCESSING,
        to_account_id: actorAcc.id,
      });
      qrInProgress.manager.findOne
        .mockResolvedValueOnce(actorAcc)
        .mockResolvedValueOnce(inFlightTx);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrInProgress);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: false,
        record: buildMockIdempotencyKey({
          status: IdempotencyKeyStatus.IN_PROGRESS,
          transaction_id: inFlightTx.id,
        }),
      });

      const replayInProgress = await service.deposit('user-1', VALID_KEY, {
        amount: '100000.00',
      });
      expect(replayInProgress.statusCode).toBe(HttpStatus.ACCEPTED);
      expect(replayInProgress.transaction.id).toBe('tx-inflight-1');

      // 4. Khóa IN_PROGRESS khi transaction_id = null (fallback 202)
      const qrInProgressNullTx = createMockQueryRunner();
      qrInProgressNullTx.manager.findOne.mockResolvedValueOnce(actorAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrInProgressNullTx);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: false,
        record: buildMockIdempotencyKey({
          status: IdempotencyKeyStatus.IN_PROGRESS,
          transaction_id: null,
        }),
      });

      const replayFallback = await service.transfer('user-1', VALID_KEY, {
        toAccountNumber: '1000000002',
        amount: '50000.00',
      });
      expect(replayFallback.statusCode).toBe(HttpStatus.ACCEPTED);
      expect(replayFallback.transaction.status).toBe(
        TransactionStatus.PROCESSING,
      );
    });
  });

  // =========================================================================
  // 4. PHA B THÀNH CÔNG (TRANSFER, DEPOSIT, WITHDRAW, REVERSAL)
  // =========================================================================

  describe('Pha B Thành công — transfer, deposit, withdraw & reverseTransaction', () => {
    it('transfer thành công ở đúng biên hạn mức lần (30,000,000.00) và biên hạn mức ngày (50,000,000.00)', async () => {
      const senderAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
        account_number: '1000000001',
        balance: '50000000.00',
        hold_amount: '20000000.00', // Khả dụng đúng bằng 30,000,000.00
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
      });
      const receiverAcc = buildMockAccount({
        id: 'acc-receiver',
        user_id: 'user-receiver',
        account_number: '1000000002',
        balance: '2000000.00',
        hold_amount: '0.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.VIP,
      });

      const qrPhaseA = createMockQueryRunner();
      qrPhaseA.manager.findOne
        .mockResolvedValueOnce(senderAcc)
        .mockResolvedValueOnce(receiverAcc);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-rec-1' }),
      });

      const qrPhaseB = createMockQueryRunner();
      qrPhaseB.manager.queryBuilder.getMany.mockResolvedValueOnce([
        senderAcc,
        receiverAcc,
      ]);
      // Đã dùng 20,000,000.00 hôm nay -> cộng 30,000,000.00 đúng bằng trần 50,000,000.00/ngày!
      qrPhaseB.manager.query.mockResolvedValueOnce([
        { used_today: '20000000.00' },
      ]);
      qrPhaseB.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '20000000.00' }],
        })
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '32000000.00' }],
        })
        .mockResolvedValueOnce({ affected: 1 });

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrPhaseA)
        .mockReturnValueOnce(qrPhaseB);

      const res = await service.transfer('user-sender', VALID_KEY, {
        toAccountNumber: '1000000002',
        amount: '30000000.00',
        description: 'Bien han muc va kha dung',
      });

      expect(res.statusCode).toBe(HttpStatus.CREATED);
      expect(res.transaction.status).toBe(TransactionStatus.COMPLETED);
      expect(res.transaction.amount).toBe('30000000.00');
      expect(qrPhaseB.manager.insert).toHaveBeenCalledTimes(2);
      expect(
        mockIdempotencyService.completeInTransaction,
      ).toHaveBeenCalledTimes(1);
    });

    it('deposit và withdraw thành công: ghi đúng 1 bút toán sổ cái (CREDIT cho deposit, DEBIT cho withdraw)', async () => {
      const myAcc = buildMockAccount({
        id: 'acc-1',
        user_id: 'user-1',
        balance: '1000000.00',
        hold_amount: '0.00',
      });

      const qrDepA = createMockQueryRunner();
      qrDepA.manager.findOne.mockResolvedValueOnce(myAcc);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-dep-1' }),
      });

      const qrDepB = createMockQueryRunner();
      qrDepB.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrDepB.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '1500000.00' }],
        })
        .mockResolvedValueOnce({ affected: 1 });

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrDepA)
        .mockReturnValueOnce(qrDepB);

      const depRes = await service.deposit('user-1', VALID_KEY, {
        amount: '500000.00',
        description: 'Nap tien',
      });
      expect(depRes.statusCode).toBe(HttpStatus.CREATED);
      expect(qrDepB.manager.insert).toHaveBeenCalledWith(
        LedgerEntry,
        expect.objectContaining({
          type: LedgerEntryType.CREDIT,
          balance_after: '1500000.00',
        }),
      );

      const qrWitA = createMockQueryRunner();
      qrWitA.manager.findOne.mockResolvedValueOnce(myAcc);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-wit-1' }),
      });

      const qrWitB = createMockQueryRunner();
      qrWitB.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrWitB.manager.query.mockResolvedValueOnce([{ used_today: '0.00' }]);
      qrWitB.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '700000.00' }],
        })
        .mockResolvedValueOnce({ affected: 1 });

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrWitA)
        .mockReturnValueOnce(qrWitB);

      const witRes = await service.withdraw('user-1', VALID_KEY, {
        amount: '300000.00',
        description: 'Rut tien',
      });
      expect(witRes.statusCode).toBe(HttpStatus.CREATED);
      expect(qrWitB.manager.insert).toHaveBeenCalledWith(
        LedgerEntry,
        expect.objectContaining({
          type: LedgerEntryType.DEBIT,
          balance_after: '700000.00',
        }),
      );
    });

    it('reverseTransaction thành công: đảo ngược từng bút toán gốc và đóng dấu cả giao dịch REVERSAL (COMPLETED) lẫn giao dịch gốc (REVERSED)', async () => {
      const adminAcc = buildMockAccount({
        id: 'acc-admin',
        user_id: 'admin-1',
      });
      const senderAcc = buildMockAccount({
        id: 'acc-a',
        account_number: '1000000001',
        balance: '900000.00',
      });
      const receiverAcc = buildMockAccount({
        id: 'acc-b',
        account_number: '1000000002',
        balance: '500000.00',
      });
      const origTx = buildMockTransaction({
        id: 'orig-tx-1',
        from_account_id: senderAcc.id,
        to_account_id: receiverAcc.id,
        fromAccount: senderAcc,
        toAccount: receiverAcc,
        amount: '100000.00',
        type: TransactionType.TRANSFER,
        status: TransactionStatus.COMPLETED,
      });

      const qrRevA = createMockQueryRunner();
      qrRevA.manager.findOne
        .mockResolvedValueOnce(adminAcc)
        .mockResolvedValueOnce(origTx);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-rev-1' }),
      });

      const qrRevB = createMockQueryRunner();
      qrRevB.manager.find.mockResolvedValueOnce([
        {
          id: '1',
          account_id: senderAcc.id,
          transaction_id: origTx.id,
          type: LedgerEntryType.DEBIT,
          amount: '100000.00',
        },
        {
          id: '2',
          account_id: receiverAcc.id,
          transaction_id: origTx.id,
          type: LedgerEntryType.CREDIT,
          amount: '100000.00',
        },
      ]);
      qrRevB.manager.queryBuilder.getMany.mockResolvedValueOnce([
        senderAcc,
        receiverAcc,
      ]);
      qrRevB.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '1000000.00' }],
        })
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '400000.00' }],
        })
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 1 });

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrRevA)
        .mockReturnValueOnce(qrRevB);

      const revRes = await service.reverseTransaction(
        'admin-1',
        origTx.id,
        VALID_KEY,
        { reason: 'Khach chuyen nham' },
      );

      expect(revRes.statusCode).toBe(HttpStatus.CREATED);
      expect(revRes.transaction.status).toBe(TransactionStatus.COMPLETED);
      expect(qrRevB.manager.insert).toHaveBeenCalledTimes(2);
    });

    it('Pha A của reverseTransaction: hỗ trợ Replay và từ chối khi gốc không tồn tại (404), là REVERSAL (409), khác COMPLETED (409), hoặc đụng 23505 (409)', async () => {
      const adminAcc = buildMockAccount({
        id: 'acc-admin',
        user_id: 'admin-1',
      });

      // 0. Replay COMPLETED cho reverseTransaction -> 200 OK
      const qrReplay = createMockQueryRunner();
      qrReplay.manager.findOne.mockResolvedValueOnce(adminAcc);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qrReplay);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: false,
        record: buildMockIdempotencyKey({
          status: IdempotencyKeyStatus.COMPLETED,
          response_status: 201,
          response_body: { id: 'rev-snap-1', status: 'COMPLETED' },
        }),
      });
      const revReplay = await service.reverseTransaction(
        'admin-1',
        'orig-1',
        VALID_KEY,
        {},
      );
      expect(revReplay.statusCode).toBe(HttpStatus.OK);

      // 1. Giao dịch gốc không tồn tại -> 404
      const qr1 = createMockQueryRunner();
      qr1.manager.findOne
        .mockResolvedValueOnce(adminAcc)
        .mockResolvedValueOnce(null);
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr1);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.reverseTransaction('admin-1', 'missing-tx', VALID_KEY, {}),
      ).rejects.toThrow(NotFoundException);

      // 2. Giao dịch gốc là REVERSAL -> 409
      const qr2 = createMockQueryRunner();
      qr2.manager.findOne.mockResolvedValueOnce(adminAcc).mockResolvedValueOnce(
        buildMockTransaction({
          type: TransactionType.REVERSAL,
          status: TransactionStatus.COMPLETED,
        }),
      );
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr2);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.reverseTransaction('admin-1', 'rev-tx', VALID_KEY, {}),
      ).rejects.toThrow(ConflictException);

      // 3. Giao dịch gốc đang FAILED -> 409
      const qr3 = createMockQueryRunner();
      qr3.manager.findOne.mockResolvedValueOnce(adminAcc).mockResolvedValueOnce(
        buildMockTransaction({
          type: TransactionType.TRANSFER,
          status: TransactionStatus.FAILED,
        }),
      );
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr3);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.reverseTransaction('admin-1', 'failed-tx', VALID_KEY, {}),
      ).rejects.toThrow(ConflictException);

      // 4. Đụng PG_UNIQUE_VIOLATION (23505) -> 409
      const qr4 = createMockQueryRunner();
      qr4.manager.findOne.mockResolvedValueOnce(adminAcc).mockResolvedValueOnce(
        buildMockTransaction({
          type: TransactionType.TRANSFER,
          status: TransactionStatus.COMPLETED,
        }),
      );
      qr4.manager.save.mockRejectedValueOnce({ code: PG_UNIQUE_VIOLATION });
      mockDataSource.createQueryRunner.mockReturnValueOnce(qr4);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey(),
      });

      await expect(
        service.reverseTransaction('admin-1', 'orig-tx', VALID_KEY, {}),
      ).rejects.toThrow(ConflictException);
    });
  });

  // =========================================================================
  // 5. CÁC NHÁNH LỖI NGHIỆP VỤ Ở PHA B & PHA C (BÀI 7.1, 5.1, 5.2, 1.4, 3.2)
  // =========================================================================

  describe('Pha B & Pha C — Mọi nhánh lỗi nghiệp vụ, Thứ tự ưu tiên, Giá trị biên 0.01đ, Deadlock & Timeout', () => {
    it.each([
      [
        'tài khoản nguồn bị FROZEN -> SOURCE_ACCOUNT_FROZEN',
        AccountStatus.FROZEN,
        AccountStatus.ACTIVE,
        TransactionFailureCode.SOURCE_ACCOUNT_FROZEN,
      ],
      [
        'tài khoản nguồn bị CLOSED -> SOURCE_ACCOUNT_CLOSED',
        AccountStatus.CLOSED,
        AccountStatus.ACTIVE,
        TransactionFailureCode.SOURCE_ACCOUNT_CLOSED,
      ],
      [
        'tài khoản đích bị FROZEN -> DESTINATION_ACCOUNT_FROZEN',
        AccountStatus.ACTIVE,
        AccountStatus.FROZEN,
        TransactionFailureCode.DESTINATION_ACCOUNT_FROZEN,
      ],
      [
        'tài khoản đích bị CLOSED -> DESTINATION_ACCOUNT_CLOSED',
        AccountStatus.ACTIVE,
        AccountStatus.CLOSED,
        TransactionFailureCode.DESTINATION_ACCOUNT_CLOSED,
      ],
    ])(
      'kiểm tra trạng thái tài khoản ở Pha B: %s (rollback Pha B và ghi FAILED ở Pha C)',
      async (_label, sourceStatus, destStatus, expectedFailureCode) => {
        const senderAcc = buildMockAccount({
          id: 'acc-sender',
          user_id: 'user-sender',
          account_number: '1000000001',
          balance: '5000000.00',
          status: sourceStatus,
        });
        const receiverAcc = buildMockAccount({
          id: 'acc-receiver',
          user_id: 'user-receiver',
          account_number: '1000000002',
          balance: '1000000.00',
          status: destStatus,
        });

        const qrPhaseB = createMockQueryRunner();
        qrPhaseB.manager.queryBuilder.getMany.mockResolvedValueOnce([
          senderAcc,
          receiverAcc,
        ]);

        const { qrPhaseC } = setupPhaseAAndPhaseCRunners(
          [qrPhaseB],
          senderAcc,
          receiverAcc,
        );

        await expect(
          service.transfer('user-sender', VALID_KEY, {
            toAccountNumber: '1000000002',
            amount: '100000.00',
          }),
        ).rejects.toThrow(UnprocessableEntityException);

        expect(qrPhaseB.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(qrPhaseC.manager.queryBuilder.set).toHaveBeenCalledWith(
          expect.objectContaining({
            status: TransactionStatus.FAILED,
            failure_code: expectedFailureCode,
          }),
        );
        expect(mockIdempotencyService.failInTransaction).toHaveBeenCalledWith(
          qrPhaseC.manager,
          'idem-rec-test',
          HttpStatus.UNPROCESSABLE_ENTITY,
          expect.objectContaining({ statusCode: 422 }),
        );
      },
    );

    it('thứ tự ưu tiên kiểm tra ở Pha B: bắt lỗi user đích bị locked (DESTINATION_UNAVAILABLE) trước trạng thái tài khoản, và bắt trạng thái tài khoản (FROZEN) trước hạn mức và trước số dư khả dụng', async () => {
      // Kịch bản 1: Chủ tài khoản đích bị locked (user.status = LOCKED) dù account đích đang FROZEN -> phải bắt DESTINATION_UNAVAILABLE trước
      const senderAcc1 = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
      });
      const receiverAccLockedUser = buildMockAccount({
        id: 'acc-receiver',
        user_id: 'user-receiver',
        account_number: '1000000002',
        status: AccountStatus.FROZEN,
        user: buildMockUser({
          id: 'user-receiver',
          status: UserStatus.LOCKED,
        }),
      });

      const qrB1 = createMockQueryRunner();
      qrB1.manager.queryBuilder.getMany.mockResolvedValueOnce([
        senderAcc1,
        receiverAccLockedUser,
      ]);
      const { qrPhaseC: qrC1 } = setupPhaseAAndPhaseCRunners(
        [qrB1],
        senderAcc1,
        receiverAccLockedUser,
      );

      await expect(
        service.transfer('user-sender', VALID_KEY, {
          toAccountNumber: '1000000002',
          amount: '50000.00',
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(qrC1.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.DESTINATION_UNAVAILABLE,
        }),
      );

      // Kịch bản 2: Tài khoản nguồn đồng thời bị FROZEN + vượt hạn mức 99M + số dư = 0 -> phải bắt SOURCE_ACCOUNT_FROZEN trước tiên
      const senderAllErrors = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
        balance: '0.00',
        status: AccountStatus.FROZEN,
        tier: AccountTier.STANDARD,
      });
      const qrB2 = createMockQueryRunner();
      qrB2.manager.queryBuilder.getMany.mockResolvedValueOnce([
        senderAllErrors,
      ]);
      const { qrPhaseC: qrC2 } = setupPhaseAAndPhaseCRunners(
        [qrB2],
        senderAllErrors,
      );

      await expect(
        service.withdraw('user-sender', VALID_KEY, { amount: '99000000.00' }),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(qrC2.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.SOURCE_ACCOUNT_FROZEN,
        }),
      );
      // Không cần gọi truy vấn tính hạn mức vì đã bị chặn ở bước kiểm tra trạng thái tài khoản
      expect(qrB2.manager.query).not.toHaveBeenCalled();
    });

    it('kiểm tra biên hạn mức ở Pha B: vượt hạn mức lần đúng 0.01đ (30,000,000.01) -> LIMIT_PER_TRANSACTION_EXCEEDED; vượt hạn mức ngày đúng 0.01đ -> LIMIT_PER_DAY_EXCEEDED', async () => {
      const senderAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
        balance: '100000000.00',
        tier: AccountTier.STANDARD,
      });

      // 1. Vượt hạn mức mỗi lần đúng 0.01đ (30,000,000.01 > 30,000,000.00)
      const qrB1 = createMockQueryRunner();
      qrB1.manager.queryBuilder.getMany.mockResolvedValueOnce([senderAcc]);
      qrB1.manager.query.mockResolvedValueOnce([{ used_today: '0.00' }]);
      const { qrPhaseC: qrC1 } = setupPhaseAAndPhaseCRunners([qrB1], senderAcc);

      await expect(
        service.withdraw('user-sender', VALID_KEY, {
          amount: '30000000.01',
        }),
      ).rejects.toThrow(/30\.000\.000 ₫/);

      expect(qrC1.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.LIMIT_PER_TRANSACTION_EXCEEDED,
        }),
      );

      // 2. Đã dùng 49,500,000.00 hôm nay (còn lại 500,000.00), rút 500,000.01 (vượt đúng 0.01đ) -> LIMIT_PER_DAY_EXCEEDED
      const qrB2 = createMockQueryRunner();
      qrB2.manager.queryBuilder.getMany.mockResolvedValueOnce([senderAcc]);
      qrB2.manager.query.mockResolvedValueOnce([{ used_today: '49500000.00' }]);
      const { qrPhaseC: qrC2 } = setupPhaseAAndPhaseCRunners([qrB2], senderAcc);

      await expect(
        service.withdraw('user-sender', VALID_KEY, {
          amount: '500000.01',
        }),
      ).rejects.toThrow(/500\.000 ₫/);

      expect(qrC2.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.LIMIT_PER_DAY_EXCEEDED,
        }),
      );
    });

    it.each([
      ['số dư = 0, rút 0.01đ', '0.00', '0.00', '0.01'],
      ['số dư âm (dữ liệu hỏng), rút 10.00đ', '-100.00', '0.00', '10.00'],
      [
        'hold = balance (khả dụng = 0), rút 100.00đ',
        '1000000.00',
        '1000000.00',
        '100.00',
      ],
      [
        'vượt số dư khả dụng đúng 0.01đ (khả dụng 600,000.00, rút 600,000.01)',
        '1000000.00',
        '400000.00',
        '600000.01',
      ],
    ])(
      'kiểm tra biên số dư khả dụng ở Pha B (%s) -> từ chối với 422 INSUFFICIENT_BALANCE',
      async (_label, balance, holdAmount, withdrawAmount) => {
        const senderAcc = buildMockAccount({
          id: 'acc-sender',
          user_id: 'user-sender',
          balance,
          hold_amount: holdAmount,
          tier: AccountTier.STANDARD,
        });

        const qrB = createMockQueryRunner();
        qrB.manager.queryBuilder.getMany.mockResolvedValueOnce([senderAcc]);
        qrB.manager.query.mockResolvedValueOnce([{ used_today: '0.00' }]);
        const { qrPhaseC } = setupPhaseAAndPhaseCRunners([qrB], senderAcc);

        await expect(
          service.withdraw('user-sender', VALID_KEY, {
            amount: withdrawAmount,
          }),
        ).rejects.toThrow(UnprocessableEntityException);

        expect(qrPhaseC.manager.queryBuilder.set).toHaveBeenCalledWith(
          expect.objectContaining({
            failure_code: TransactionFailureCode.INSUFFICIENT_BALANCE,
          }),
        );
      },
    );

    it('bắt lỗi tràn số PG_NUMERIC_OVERFLOW (22003) ở creditAccount -> ghi FAILED với mã AMOUNT_OVERFLOW (422)', async () => {
      const myAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
      });

      const qrB = createMockQueryRunner();
      qrB.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrB.manager.queryBuilder.execute.mockRejectedValueOnce({
        code: PG_NUMERIC_OVERFLOW,
      });

      const { qrPhaseC } = setupPhaseAAndPhaseCRunners([qrB], myAcc);

      await expect(
        service.deposit('user-sender', VALID_KEY, {
          amount: '9999999999999999.99',
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(qrPhaseC.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.AMOUNT_OVERFLOW,
        }),
      );
    });

    it.each([[PG_LOCK_NOT_AVAILABLE], [PG_QUERY_CANCELED]])(
      'bắt lỗi timeout chờ khóa PostgreSQL (%s) ở Pha B -> trả 503 ServiceUnavailableException và ghi FAILED (SERVER_BUSY)',
      async (pgErrorCode) => {
        const myAcc = buildMockAccount({
          id: 'acc-sender',
          user_id: 'user-sender',
        });

        const qrB = createMockQueryRunner();
        qrB.manager.queryBuilder.getMany.mockRejectedValueOnce({
          code: pgErrorCode,
        });

        const { qrPhaseC } = setupPhaseAAndPhaseCRunners([qrB], myAcc);

        await expect(
          service.deposit('user-sender', VALID_KEY, { amount: '100000.00' }),
        ).rejects.toThrow(ServiceUnavailableException);

        expect(qrPhaseC.manager.queryBuilder.set).toHaveBeenCalledWith(
          expect.objectContaining({
            failure_code: TransactionFailureCode.SERVER_BUSY,
          }),
        );
      },
    );

    it('Deadlock 40P01: tự động retry thành công ở lần thử thứ 2 và cập nhật bộ đếm deadlockStats (deadlockDetected = 1, retrySucceeded = 1)', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });

      const myAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
        balance: '1000000.00',
      });

      const qrPhaseA = createMockQueryRunner();
      qrPhaseA.manager.findOne.mockResolvedValueOnce(myAcc);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-dl-1' }),
      });

      // Lần thử 1 của Pha B: đụng Deadlock 40P01
      const qrBAttempt1 = createMockQueryRunner();
      qrBAttempt1.manager.queryBuilder.getMany.mockRejectedValueOnce({
        code: PG_DEADLOCK_DETECTED,
      });

      // Lần thử 2 của Pha B: thành công!
      const qrBAttempt2 = createMockQueryRunner();
      qrBAttempt2.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrBAttempt2.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '1200000.00' }],
        })
        .mockResolvedValueOnce({ affected: 1 });

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrPhaseA)
        .mockReturnValueOnce(qrBAttempt1)
        .mockReturnValueOnce(qrBAttempt2);

      const res = await service.deposit('user-sender', VALID_KEY, {
        amount: '200000.00',
      });

      expect(res.statusCode).toBe(HttpStatus.CREATED);
      expect(service.getDeadlockStats()).toEqual({
        deadlockDetected: 1,
        retrySucceeded: 1,
        retryExhausted: 0,
      });
    });

    it('Deadlock 40P01 vượt quá MAX_DEADLOCK_RETRIES (3 lần retry = 4 lần thử): tăng retryExhausted = 1, ghi FAILED (SERVER_BUSY) và trả 503', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });

      const myAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
      });

      const qrB1 = createMockQueryRunner();
      const qrB2 = createMockQueryRunner();
      const qrB3 = createMockQueryRunner();
      const qrB4 = createMockQueryRunner();
      for (const qr of [qrB1, qrB2, qrB3, qrB4]) {
        qr.manager.queryBuilder.getMany.mockRejectedValueOnce({
          code: PG_DEADLOCK_DETECTED,
        });
      }

      const { qrPhaseC } = setupPhaseAAndPhaseCRunners(
        [qrB1, qrB2, qrB3, qrB4],
        myAcc,
      );

      await expect(
        service.deposit('user-sender', VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(service.getDeadlockStats()).toEqual({
        deadlockDetected: 4,
        retrySucceeded: 0,
        retryExhausted: 1,
      });
      expect(qrPhaseC.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.SERVER_BUSY,
        }),
      );
    });

    it('lỗi bất ngờ ở Pha B (hoặc debitAccount/creditAccount trả affected = 0) -> trả 500 thông báo chung, không lộ lỗi DB và ghi FAILED (INTERNAL_ERROR)', async () => {
      const myAcc = buildMockAccount({
        id: 'acc-sender',
        user_id: 'user-sender',
        balance: '1000000.00',
      });

      // 1. Lỗi bất ngờ từ DB
      const qrB1 = createMockQueryRunner();
      qrB1.manager.queryBuilder.getMany.mockRejectedValueOnce(
        new Error('Secret internal SQL syntax crash at table accounts'),
      );
      const { qrPhaseC: qrC1 } = setupPhaseAAndPhaseCRunners([qrB1], myAcc);

      await expect(
        service.deposit('user-sender', VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow('Lỗi hệ thống khi thực hiện giao dịch');

      expect(qrC1.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.INTERNAL_ERROR,
        }),
      );

      // 2. creditAccount trả affected = 0 -> INTERNAL_ERROR (500)
      const qrB2 = createMockQueryRunner();
      qrB2.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrB2.manager.queryBuilder.execute.mockResolvedValueOnce({
        affected: 0,
        raw: [],
      });
      setupPhaseAAndPhaseCRunners([qrB2], myAcc);

      await expect(
        service.deposit('user-sender', VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow('Lỗi hệ thống khi thực hiện giao dịch');

      // 3. debitAccount trả affected = 0 -> INSUFFICIENT_BALANCE (422)
      const qrB3 = createMockQueryRunner();
      qrB3.manager.queryBuilder.getMany.mockResolvedValueOnce([myAcc]);
      qrB3.manager.query.mockResolvedValueOnce([{ used_today: '0.00' }]);
      qrB3.manager.queryBuilder.execute.mockResolvedValueOnce({
        affected: 0,
        raw: [],
      });
      setupPhaseAAndPhaseCRunners([qrB3], myAcc);

      await expect(
        service.withdraw('user-sender', VALID_KEY, { amount: '100000.00' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('các nhánh lỗi ở Pha B của reverseTransaction: bên nhận thiếu số dư khả dụng (422 REVERSAL_INSUFFICIENT_BALANCE), không có bút toán gốc (500), hoặc đụng ConflictException khi đóng dấu gốc (409)', async () => {
      const adminAcc = buildMockAccount({
        id: 'acc-admin',
        user_id: 'admin-1',
      });
      const receiverBroke = buildMockAccount({
        id: 'acc-b',
        balance: '50000.00',
        hold_amount: '20000.00', // Khả dụng chỉ còn 30,000.00 < 100,000.00 cần thu hồi
        status: AccountStatus.ACTIVE,
      });
      const origTx = buildMockTransaction({
        id: 'orig-tx-1',
        from_account_id: null,
        to_account_id: receiverBroke.id,
        toAccount: receiverBroke,
        amount: '100000.00',
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.COMPLETED,
      });

      // 1. Bên nhận thiếu số dư khả dụng -> 422 REVERSAL_INSUFFICIENT_BALANCE
      const qrRevA1 = createMockQueryRunner();
      qrRevA1.manager.findOne
        .mockResolvedValueOnce(adminAcc)
        .mockResolvedValueOnce(origTx);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-rev-fail-1' }),
      });

      const qrRevB1 = createMockQueryRunner();
      qrRevB1.manager.find.mockResolvedValueOnce([
        {
          id: '1',
          account_id: receiverBroke.id,
          transaction_id: origTx.id,
          type: LedgerEntryType.CREDIT,
          amount: '100000.00',
        },
      ]);
      qrRevB1.manager.queryBuilder.getMany.mockResolvedValueOnce([
        receiverBroke,
      ]);

      const qrRevC1 = createMockQueryRunner();
      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrRevA1)
        .mockReturnValueOnce(qrRevB1)
        .mockReturnValueOnce(qrRevC1);

      await expect(
        service.reverseTransaction('admin-1', origTx.id, VALID_KEY, {}),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(qrRevC1.manager.queryBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failure_code: TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE,
        }),
      );

      // 2. Khi đóng dấu giao dịch gốc COMPLETED -> REVERSED ở cuối Pha B bị affected = 0 (ConflictException 409)
      const receiverRich = buildMockAccount({
        id: 'acc-b',
        balance: '500000.00',
        status: AccountStatus.ACTIVE,
      });
      const qrRevA2 = createMockQueryRunner();
      qrRevA2.manager.findOne
        .mockResolvedValueOnce(adminAcc)
        .mockResolvedValueOnce(origTx);
      mockIdempotencyService.beginIdempotency.mockResolvedValueOnce({
        isNew: true,
        record: buildMockIdempotencyKey({ id: 'idem-rev-conflict' }),
      });

      const qrRevB2 = createMockQueryRunner();
      qrRevB2.manager.find.mockResolvedValueOnce([
        {
          id: '1',
          account_id: receiverRich.id,
          transaction_id: origTx.id,
          type: LedgerEntryType.CREDIT,
          amount: '100000.00',
        },
      ]);
      qrRevB2.manager.queryBuilder.getMany.mockResolvedValueOnce([
        receiverRich,
      ]);
      qrRevB2.manager.queryBuilder.execute
        .mockResolvedValueOnce({
          affected: 1,
          raw: [{ balance: '400000.00' }],
        }) // debitAccount
        .mockResolvedValueOnce({ affected: 1 }) // transition reversalTx -> COMPLETED
        .mockResolvedValueOnce({ affected: 0 }); // transition origTx -> REVERSED bị trùng (affected = 0 -> 409)

      const qrRevC2 = createMockQueryRunner();
      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qrRevA2)
        .mockReturnValueOnce(qrRevB2)
        .mockReturnValueOnce(qrRevC2);

      await expect(
        service.reverseTransaction('admin-1', origTx.id, VALID_KEY, {}),
      ).rejects.toThrow(ConflictException);
    });
  });

  // =========================================================================
  // 6. QUÉT GIAO DỊCH TREO (sweepStuckTransactions & Cron)
  // =========================================================================

  describe('sweepStuckTransactions & handleStuckTransactionsCron', () => {
    it('quét giao dịch PROCESSING quá hạn: đóng dấu FAILED (TIMEOUT) + đóng khóa Idempotency cho phiếu có 0 bút toán, và bỏ qua + log ERROR cho phiếu đã có bút toán', async () => {
      mockDataSource.query.mockResolvedValueOnce([
        {
          id: 'tx-stuck-clean',
          type: TransactionType.WITHDRAW,
          ledger_count: '0',
        },
        {
          id: 'tx-stuck-anomaly',
          type: TransactionType.TRANSFER,
          ledger_count: '2',
        },
      ]);

      const loggerErrorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);

      const res = await service.sweepStuckTransactions(120);

      expect(res).toEqual({
        sweptCount: 1,
        skippedWithLedgerCount: 1,
        sweptIds: ['tx-stuck-clean'],
      });
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(
        mockIdempotencyService.failStuckKeyByTransactionId,
      ).toHaveBeenCalledWith(
        expect.anything(),
        'tx-stuck-clean',
        HttpStatus.SERVICE_UNAVAILABLE,
        expect.objectContaining({ statusCode: 503 }),
      );
    });

    it('handleStuckTransactionsCron bỏ qua khi NODE_ENV === "test" và gọi sweepStuckTransactions khi khác "test"', async () => {
      const prevEnv = process.env.NODE_ENV;
      const spySweep = jest
        .spyOn(service, 'sweepStuckTransactions')
        .mockResolvedValue({
          sweptCount: 0,
          skippedWithLedgerCount: 0,
          sweptIds: [],
        });

      process.env.NODE_ENV = 'test';
      await service.handleStuckTransactionsCron();
      expect(spySweep).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'production';
      await service.handleStuckTransactionsCron();
      expect(spySweep).toHaveBeenCalledTimes(1);

      process.env.NODE_ENV = prevEnv;
    });
  });
});
