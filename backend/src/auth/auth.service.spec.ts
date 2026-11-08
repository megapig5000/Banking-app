import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole, UserStatus } from '../database/entities/user.entity';
import {
  buildMockAccount,
  buildMockUser,
  createMockQueryRunner,
  createMockRepository,
} from '../test-utils/mock-helpers';

const VALID_PASSWORD = 'Password@123';
const REAL_PASSWORD_HASH = bcrypt.hashSync(VALID_PASSWORD, 4);

describe('AuthService, JwtStrategy, JwtAuthGuard & RolesGuard — Xác thực, Đăng ký, Phiên JWT & Phân quyền RBAC', () => {
  let authService: AuthService;
  let userRepo: ReturnType<typeof createMockRepository>;
  let mockDataSource: { createQueryRunner: jest.Mock };
  let mockJwtService: { sign: jest.Mock };

  beforeEach(() => {
    userRepo = createMockRepository();
    mockDataSource = {
      createQueryRunner: jest.fn(),
    };
    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-access-token'),
    };

    authService = new AuthService(
      userRepo as any,
      mockDataSource as any,
      mockJwtService as any,
    );
  });

  // =========================================================================
  // 1. AUTH SERVICE — REGISTER
  // =========================================================================

  describe('AuthService.register', () => {
    it('từ chối với 409 ConflictException khi email đã tồn tại (kể cả user đã xóa mềm với withDeleted: true)', async () => {
      userRepo.findOne.mockResolvedValueOnce(
        buildMockUser({ deleted_at: new Date() }),
      );

      await expect(
        authService.register({
          fullName: 'Nguyen Van A',
          email: 'existing@bank.local',
          password: VALID_PASSWORD,
        }),
      ).rejects.toThrow(ConflictException);

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { email: 'existing@bank.local' },
        withDeleted: true,
      });
      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('đăng ký thành công (kể cả khi lần thử số tài khoản đầu tiên bị trùng, lần 2 thành công), sanitize fullName và không lộ password_hash', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      const qr = createMockQueryRunner();
      const savedUser = buildMockUser({
        id: 'new-user-id',
        full_name: 'Nguyen &lt;b&gt;A&lt;/b&gt;',
        email: 'new@bank.local',
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });

      qr.manager.save
        .mockResolvedValueOnce(savedUser)
        .mockResolvedValueOnce(buildMockAccount({ user_id: savedUser.id }));

      qr.manager.findOne
        .mockResolvedValueOnce(buildMockAccount())
        .mockResolvedValueOnce(null);

      mockDataSource.createQueryRunner.mockReturnValueOnce(qr);

      const res = await authService.register({
        fullName: 'Nguyen <b>A</b>',
        email: 'new@bank.local',
        password: VALID_PASSWORD,
      });

      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
      expect(res).toEqual({
        id: 'new-user-id',
        fullName: 'Nguyen &lt;b&gt;A&lt;/b&gt;',
        email: 'new@bank.local',
        phone: null,
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      expect((res as any).password_hash).toBeUndefined();
    });

    it('ném 500 InternalServerErrorException và rollbackTransaction nếu cả 5 lần thử sinh số tài khoản đều bị trùng', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      const qr = createMockQueryRunner();
      qr.manager.save.mockResolvedValueOnce(buildMockUser());
      qr.manager.findOne.mockResolvedValue(buildMockAccount());

      mockDataSource.createQueryRunner.mockReturnValueOnce(qr);

      await expect(
        authService.register({
          fullName: 'Nguyen Van A',
          email: 'retry5@bank.local',
          password: VALID_PASSWORD,
        }),
      ).rejects.toThrow(InternalServerErrorException);

      expect(qr.manager.findOne).toHaveBeenCalledTimes(5);
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 2. AUTH SERVICE — LOGIN
  // =========================================================================

  describe('AuthService.login', () => {
    it('từ chối với 401 UnauthorizedException khi email không tồn tại (hoặc đã bị xóa mềm)', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        authService.login({
          email: 'nonexistent@bank.local',
          password: VALID_PASSWORD,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('từ chối với 401 UnauthorizedException khi mật khẩu không chính xác', async () => {
      userRepo.findOne.mockResolvedValueOnce(
        buildMockUser({ password_hash: REAL_PASSWORD_HASH }),
      );

      await expect(
        authService.login({
          email: 'user1@bank.local',
          password: 'WrongPassword@999',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('từ chối với 403 ForbiddenException khi mật khẩu đúng nhưng tài khoản đang bị khóa (status = locked)', async () => {
      userRepo.findOne.mockResolvedValueOnce(
        buildMockUser({
          password_hash: REAL_PASSWORD_HASH,
          status: UserStatus.LOCKED,
        }),
      );

      await expect(
        authService.login({
          email: 'locked@bank.local',
          password: VALID_PASSWORD,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('trả về accessToken và thông tin user (không có password_hash) khi đăng nhập hợp lệ', async () => {
      const activeUser = buildMockUser({
        id: 'user-active-1',
        full_name: 'Active User',
        email: 'active@bank.local',
        phone: '0901234567',
        password_hash: REAL_PASSWORD_HASH,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      });
      userRepo.findOne.mockResolvedValueOnce(activeUser);

      const res = await authService.login({
        email: 'active@bank.local',
        password: VALID_PASSWORD,
      });

      expect(mockJwtService.sign).toHaveBeenCalledWith({
        sub: 'user-active-1',
      });
      expect(res).toEqual({
        accessToken: 'mock-jwt-access-token',
        user: {
          id: 'user-active-1',
          fullName: 'Active User',
          email: 'active@bank.local',
          phone: '0901234567',
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
    });
  });

  // =========================================================================
  // 3. JWT STRATEGY & JWT AUTH GUARD
  // =========================================================================

  describe('JwtStrategy.validate & JwtAuthGuard', () => {
    let jwtStrategy: JwtStrategy;

    beforeEach(() => {
      const mockConfigService = {
        getOrThrow: jest.fn().mockReturnValue('test_secret_key'),
      };
      jwtStrategy = new JwtStrategy(mockConfigService as any, userRepo as any);
    });

    it('khởi tạo được JwtAuthGuard', () => {
      const guard = new JwtAuthGuard();
      expect(guard).toBeDefined();
    });

    it('ném 401 UnauthorizedException khi user không tồn tại hoặc đã bị xóa mềm (findOne trả về null)', async () => {
      userRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        jwtStrategy.validate({ sub: 'deleted-or-missing-user-id' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('ném 403 ForbiddenException ngay lập tức khi user trong DB đang ở trạng thái locked', async () => {
      userRepo.findOne.mockResolvedValueOnce(
        buildMockUser({ status: UserStatus.LOCKED }),
      );

      await expect(
        jwtStrategy.validate({ sub: 'locked-user-id' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('trả về thực thể User mới nhất từ DB khi user đang active', async () => {
      const user = buildMockUser({
        id: 'valid-user-1',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      });
      userRepo.findOne.mockResolvedValueOnce(user);

      const result = await jwtStrategy.validate({ sub: 'valid-user-1' });
      expect(result).toBe(user);
    });
  });

  // =========================================================================
  // 4. ROLES GUARD — KIỂM TRA VAI TRÒ RBAC
  // =========================================================================

  describe('RolesGuard.canActivate', () => {
    let rolesGuard: RolesGuard;
    let mockReflector: { getAllAndOverride: jest.Mock };

    function createMockExecutionContext(user?: any): ExecutionContext {
      return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
      } as unknown as ExecutionContext;
    }

    beforeEach(() => {
      mockReflector = {
        getAllAndOverride: jest.fn(),
      };
      rolesGuard = new RolesGuard(mockReflector as unknown as Reflector);
    });

    it('cho phép truy cập (true) khi route không yêu cầu @Roles (undefined hoặc mảng rỗng)', () => {
      mockReflector.getAllAndOverride.mockReturnValueOnce(undefined);
      expect(rolesGuard.canActivate(createMockExecutionContext())).toBe(true);

      mockReflector.getAllAndOverride.mockReturnValueOnce([]);
      expect(rolesGuard.canActivate(createMockExecutionContext())).toBe(true);
    });

    it('từ chối với 403 ForbiddenException khi thiếu req.user hoặc user.role không nằm trong danh sách yêu cầu', () => {
      mockReflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

      expect(() =>
        rolesGuard.canActivate(createMockExecutionContext(undefined)),
      ).toThrow(ForbiddenException);

      const customerUser = buildMockUser({ role: UserRole.CUSTOMER });
      expect(() =>
        rolesGuard.canActivate(createMockExecutionContext(customerUser)),
      ).toThrow(ForbiddenException);
    });

    it('cho phép truy cập (true) khi user.role khớp với vai trò yêu cầu', () => {
      mockReflector.getAllAndOverride.mockReturnValueOnce([UserRole.ADMIN]);
      const adminUser = buildMockUser({ role: UserRole.ADMIN });

      expect(
        rolesGuard.canActivate(createMockExecutionContext(adminUser)),
      ).toBe(true);
    });
  });
});
