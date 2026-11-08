import { ConflictException } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyKeyStatus } from '../database/entities/idempotency-key.entity';
import {
  buildMockIdempotencyKey,
  createMockEntityManager,
  createMockQueryBuilder,
} from '../test-utils/mock-helpers';

describe('IdempotencyService — Chuẩn hóa số tiền, Băm SHA-256 & Quản lý vòng đời khóa', () => {
  let service: IdempotencyService;
  let mockDataSource: { query: jest.Mock };

  beforeEach(() => {
    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
    };
    service = new IdempotencyService(mockDataSource as any);
  });

  describe('normalizeDecimalAmount', () => {
    it.each([
      ['10', '10.00'],
      ['10.0', '10.00'],
      ['10.00', '10.00'],
      ['10.5', '10.50'],
      ['0010.25', '10.25'],
      ['0', '0.00'],
      ['000.0', '0.00'],
      ['-50.5', '-50.50'],
      ['  250000  ', '250000.00'],
    ])('chuẩn hóa "%s" về đúng "%s"', (raw, expected) => {
      expect(service.normalizeDecimalAmount(raw)).toBe(expected);
    });
  });

  describe('computeRequestHash', () => {
    it('sinh ra cùng một mã băm SHA-256 (64 ký tự hex) cho "10", "10.0" và "10.00"', () => {
      const h1 = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000002',
        amount: '10',
        description: 'Chuyen tien',
      });
      const h2 = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: ' 1000000002 ',
        amount: '10.0',
        description: 'Chuyen tien',
      });
      const h3 = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000002',
        amount: '10.00',
        description: 'Chuyen tien',
      });

      expect(h1).toHaveLength(64);
      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
    });

    it('sinh ra mã băm khác nhau khi đổi operation, đổi số tiền, đổi người nhận hoặc đổi mô tả', () => {
      const baseTransfer = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000002',
        amount: '50000.00',
        description: null,
      });
      const diffAmount = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000002',
        amount: '50000.01',
        description: null,
      });
      const diffReceiver = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000003',
        amount: '50000.00',
        description: null,
      });
      const diffDesc = service.computeRequestHash({
        operation: 'TRANSFER',
        toAccountNumber: '1000000002',
        amount: '50000.00',
        description: 'Khac mo ta',
      });
      const depositHash = service.computeRequestHash({
        operation: 'DEPOSIT',
        amount: '50000.00',
        description: null,
      });
      const withdrawHash = service.computeRequestHash({
        operation: 'WITHDRAW',
        amount: '50000.00',
        description: null,
      });
      const reverseHash = service.computeRequestHash({
        operation: 'REVERSE',
        originalTransactionId: 'tx-orig-1',
        reason: null,
      });

      const uniqueHashes = new Set([
        baseTransfer,
        diffAmount,
        diffReceiver,
        diffDesc,
        depositHash,
        withdrawHash,
        reverseHash,
      ]);
      expect(uniqueHashes.size).toBe(7);
    });
  });

  describe('beginIdempotency', () => {
    it('trả về { isNew: true, record } khi chèn thành công khóa mới (ON CONFLICT trả về 1 dòng)', async () => {
      const newRecord = buildMockIdempotencyKey({
        request_hash: 'h'.repeat(64),
        status: IdempotencyKeyStatus.IN_PROGRESS,
      });
      const manager = createMockEntityManager({
        query: jest
          .fn()
          .mockResolvedValueOnce([]) // DELETE khóa hết hạn
          .mockResolvedValueOnce([newRecord]), // INSERT RETURNING *
      });

      const res = await service.beginIdempotency(
        manager as any,
        newRecord.user_id,
        newRecord.idempotency_key,
        newRecord.request_hash,
      );

      expect(res).toEqual({ isNew: true, record: newRecord });
      expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('trả về { isNew: false, record } khi khóa đã tồn tại và khớp request_hash', async () => {
      const existingRecord = buildMockIdempotencyKey({
        request_hash: 'same_hash'.padEnd(64, '0'),
        status: IdempotencyKeyStatus.COMPLETED,
        response_status: 201,
        response_body: { id: 'tx-1' },
      });
      const manager = createMockEntityManager({
        query: jest
          .fn()
          .mockResolvedValueOnce([]) // DELETE
          .mockResolvedValueOnce([]), // INSERT ON CONFLICT DO NOTHING -> 0 dòng
        findOne: jest.fn().mockResolvedValueOnce(existingRecord),
      });

      const res = await service.beginIdempotency(
        manager as any,
        existingRecord.user_id,
        existingRecord.idempotency_key,
        existingRecord.request_hash,
      );

      expect(res).toEqual({ isNew: false, record: existingRecord });
    });

    it('ném 409 ConflictException khi khóa đã tồn tại nhưng khác request_hash', async () => {
      const existingRecord = buildMockIdempotencyKey({
        request_hash: 'hash_cu'.padEnd(64, 'a'),
      });
      const manager = createMockEntityManager({
        query: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValueOnce(existingRecord),
      });

      await expect(
        service.beginIdempotency(
          manager as any,
          existingRecord.user_id,
          existingRecord.idempotency_key,
          'hash_moi'.padEnd(64, 'b'),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('ném 409 ConflictException nếu ON CONFLICT trả về 0 dòng nhưng findOne không tìm thấy bản ghi', async () => {
      const manager = createMockEntityManager({
        query: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValueOnce(null),
      });

      await expect(
        service.beginIdempotency(
          manager as any,
          'user-1',
          '550e8400-e29b-41d4-a716-446655440000',
          'a'.repeat(64),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('attachTransactionId, completeInTransaction, failInTransaction & failStuckKeyByTransactionId', () => {
    it('attachTransactionId cập nhật transaction_id cho dòng khóa IN_PROGRESS', async () => {
      const qb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const manager = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qb),
      });

      await service.attachTransactionId(manager as any, 'key-id-1', 'tx-id-1');
      expect(qb.set).toHaveBeenCalledWith({ transaction_id: 'tx-id-1' });
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('completeInTransaction cập nhật sang COMPLETED khi affected = 1, và ném 409 khi affected = 0', async () => {
      const qbSuccess = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const managerSuccess = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qbSuccess),
      });

      await expect(
        service.completeInTransaction(managerSuccess as any, 'key-id-1', 201, {
          id: 'tx-1',
        }),
      ).resolves.toBeUndefined();

      const qbZero = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });
      const managerZero = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qbZero),
      });

      await expect(
        service.completeInTransaction(managerZero as any, 'key-id-1', 201, {
          id: 'tx-1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('failInTransaction và failStuckKeyByTransactionId cập nhật trạng thái khóa sang FAILED kèm bản chụp lỗi', async () => {
      const qb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const manager = createMockEntityManager({
        createQueryBuilder: jest.fn(() => qb),
      });

      await service.failInTransaction(manager as any, 'key-id-1', 422, {
        message: 'Khong du so du',
      });
      expect(qb.set).toHaveBeenCalledWith({
        status: IdempotencyKeyStatus.FAILED,
        response_status: 422,
        response_body: { message: 'Khong du so du' },
      });

      await service.failStuckKeyByTransactionId(
        manager as any,
        'tx-stuck-1',
        503,
        { message: 'Timeout' },
      );
      expect(qb.set).toHaveBeenLastCalledWith({
        status: IdempotencyKeyStatus.FAILED,
        response_status: 503,
        response_body: { message: 'Timeout' },
      });
    });
  });

  describe('deleteExpiredKeys & handleExpiredKeysCleanupCron', () => {
    it('deleteExpiredKeys trả về số lượng dòng đã xóa từ câu lệnh DELETE ... RETURNING', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ id: 'k1' }, { id: 'k2' }]);
      const deleted = await service.deleteExpiredKeys();
      expect(deleted).toBe(2);

      mockDataSource.query.mockResolvedValueOnce([]);
      const deletedZero = await service.deleteExpiredKeys();
      expect(deletedZero).toBe(0);
    });

    it('handleExpiredKeysCleanupCron bỏ qua khi NODE_ENV === "test" và thực thi khi khác "test"', async () => {
      const prevEnv = process.env.NODE_ENV;
      const spyDelete = jest
        .spyOn(service, 'deleteExpiredKeys')
        .mockResolvedValue(0);

      process.env.NODE_ENV = 'test';
      await service.handleExpiredKeysCleanupCron();
      expect(spyDelete).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'development';
      await service.handleExpiredKeysCleanupCron();
      expect(spyDelete).toHaveBeenCalledTimes(1);

      process.env.NODE_ENV = prevEnv;
    });
  });
});
