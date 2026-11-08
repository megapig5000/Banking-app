import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { AccountHistory } from '../database/entities/account-history.entity';
import { User } from '../database/entities/user.entity';
import { SortOrder } from '../transactions/dto/transaction-query.dto';
import {
  buildMockUser,
  createMockEntityManager,
  createMockQueryBuilder,
  createMockRepository,
} from '../test-utils/mock-helpers';

const VALID_PASSWORD = 'Password@123';
const REAL_PASSWORD_HASH = bcrypt.hashSync(VALID_PASSWORD, 4);

describe('UsersService — Xem hồ sơ, Cập nhật hồ sơ kèm lưu vết account_history & Xem lịch sử phiên bản', () => {
  let service: UsersService;
  let userRepo: ReturnType<typeof createMockRepository>;
  let historyRepo: ReturnType<typeof createMockRepository>;
  let mockManager: ReturnType<typeof createMockEntityManager>;
  let mockDataSource: { transaction: jest.Mock };

  beforeEach(() => {
    userRepo = createMockRepository();
    historyRepo = createMockRepository();
    mockManager = createMockEntityManager();
    mockDataSource = {
      transaction: jest.fn(async (cb: any) => cb(mockManager)),
    };

    service = new UsersService(
      userRepo as any,
      historyRepo as any,
      mockDataSource as any,
    );
  });

  describe('getMyProfile', () => {
    it('trả về thông tin hồ sơ người dùng (kèm phone và profileVersion) khi tìm thấy', async () => {
      const user = buildMockUser({
        id: 'user-1',
        full_name: 'Nguyen Van A',
        email: 'user1@bank.local',
        phone: '0901234567',
        profile_version: 3,
      });
      userRepo.findOne.mockResolvedValueOnce(user);

      const res = await service.getMyProfile('user-1');
      expect(res).toEqual({
        id: 'user-1',
        fullName: 'Nguyen Van A',
        email: 'user1@bank.local',
        phone: '0901234567',
        profileVersion: 3,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
      });
    });

    it('ném 404 NotFoundException khi không tìm thấy người dùng', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getMyProfile('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateMyProfile', () => {
    it('từ chối với 400 BadRequestException khi không cung cấp trường nào (fullName, email, phone đều undefined)', async () => {
      await expect(service.updateMyProfile('user-1', {})).rejects.toThrow(
        BadRequestException,
      );
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('ném 404 NotFoundException khi không tìm thấy user dưới khóa FOR UPDATE và ném 400 khi fullName ngắn hơn 2 ký tự', async () => {
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(null);
      await expect(
        service.updateMyProfile('missing-id', { fullName: 'Valid Name' }),
      ).rejects.toThrow(NotFoundException);

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(buildMockUser());
      await expect(
        service.updateMyProfile('user-1', { fullName: ' A ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('khi đổi email: từ chối với 400 BadRequestException nếu thiếu hoặc sai currentPassword, và từ chối với 409 ConflictException nếu email mới trùng người khác', async () => {
      const currentUser = buildMockUser({
        id: 'user-1',
        email: 'old@bank.local',
        password_hash: REAL_PASSWORD_HASH,
      });

      // 1. Thiếu currentPassword -> 400
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(currentUser);
      await expect(
        service.updateMyProfile('user-1', { email: 'new@bank.local' }),
      ).rejects.toThrow(BadRequestException);

      // 2. Sai currentPassword -> 400 (không phải 401!)
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(currentUser);
      await expect(
        service.updateMyProfile('user-1', {
          email: 'new@bank.local',
          currentPassword: 'WrongPassword@123',
        }),
      ).rejects.toThrow(BadRequestException);

      // 3. Đúng currentPassword nhưng email mới đã thuộc về user khác -> 409
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(currentUser);
      mockManager.findOne.mockResolvedValueOnce(
        buildMockUser({ id: 'other-user-2', email: 'new@bank.local' }),
      );

      await expect(
        service.updateMyProfile('user-1', {
          email: 'new@bank.local',
          currentPassword: VALID_PASSWORD,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('không chèn account_history và không tăng profile_version khi không có trường nào thực sự thay đổi (No-op update)', async () => {
      const currentUser = buildMockUser({
        id: 'user-1',
        full_name: 'Nguyen Van A',
        email: 'user1@bank.local',
        phone: '0901234567',
        profile_version: 2,
      });
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(currentUser);

      const res = await service.updateMyProfile('user-1', {
        fullName: 'Nguyen Van A',
        email: '  USER1@bank.local ',
        phone: '0901234567',
      });

      expect(res.profileVersion).toBe(2);
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it('khi có thay đổi thật sự: chèn bản chụp giá trị CŨ vào account_history trước khi ghi đè, sanitize fullName và tăng profile_version + 1', async () => {
      const currentUser = buildMockUser({
        id: 'user-1',
        full_name: 'Old Name',
        email: 'old@bank.local',
        phone: null,
        profile_version: 1,
        password_hash: REAL_PASSWORD_HASH,
      });

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(currentUser);
      mockManager.findOne.mockResolvedValueOnce(null);

      const res = await service.updateMyProfile('user-1', {
        fullName: 'New <script>x</script> Name',
        email: 'new@bank.local',
        phone: '0901234567',
        currentPassword: VALID_PASSWORD,
      });

      expect(mockManager.insert).toHaveBeenCalledWith(AccountHistory, {
        user_id: 'user-1',
        version: 1,
        full_name: 'Old Name',
        email: 'old@bank.local',
        phone: null,
        changed_by_user_id: 'user-1',
      });

      expect(mockManager.save).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          id: 'user-1',
          full_name: 'New &lt;script&gt;x&lt;/script&gt; Name',
          email: 'new@bank.local',
          phone: '0901234567',
          profile_version: 2,
        }),
      );

      expect(res).toMatchObject({
        fullName: 'New &lt;script&gt;x&lt;/script&gt; Name',
        email: 'new@bank.local',
        phone: '0901234567',
        profileVersion: 2,
      });
    });
  });

  describe('getProfileHistory', () => {
    it('ném 404 NotFoundException khi không tìm thấy người dùng', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getProfileHistory(
          'missing-user',
          { page: 1, limit: 10 },
          false,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('trả về danh sách các phiên bản hồ sơ cũ có phân trang theo thứ tự yêu cầu', async () => {
      const user = buildMockUser({ id: 'user-1' });
      userRepo.findOne.mockResolvedValueOnce(user);

      const qb = createMockQueryBuilder({
        getManyAndCount: jest.fn().mockResolvedValueOnce([
          [
            {
              id: '2',
              user_id: 'user-1',
              version: 2,
              full_name: 'Name V2',
              email: 'v2@bank.local',
              phone: '0901234567',
              changed_by_user_id: 'user-1',
              created_at: new Date('2026-03-02T10:00:00Z'),
            },
            {
              id: '1',
              user_id: 'user-1',
              version: 1,
              full_name: 'Name V1',
              email: 'v1@bank.local',
              phone: null,
              changed_by_user_id: null,
              created_at: new Date('2026-03-01T10:00:00Z'),
            },
          ],
          2,
        ]),
      });
      historyRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const res = await service.getProfileHistory(
        'user-1',
        { page: 1, limit: 5, order: SortOrder.DESC },
        true,
      );

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        withDeleted: true,
      });
      expect(res.meta).toEqual({
        page: 1,
        limit: 5,
        total: 2,
        totalPages: 1,
      });
      expect(res.data).toEqual([
        {
          version: 2,
          fullName: 'Name V2',
          email: 'v2@bank.local',
          phone: '0901234567',
          changedByUserId: 'user-1',
          changedAt: new Date('2026-03-02T10:00:00Z'),
        },
        {
          version: 1,
          fullName: 'Name V1',
          email: 'v1@bank.local',
          phone: null,
          changedByUserId: null,
          changedAt: new Date('2026-03-01T10:00:00Z'),
        },
      ]);
    });
  });
});
