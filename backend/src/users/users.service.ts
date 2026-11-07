import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../database/entities/user.entity';
import { AccountHistory } from '../database/entities/account-history.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileHistoryQueryDto } from './dto/profile-history-query.dto';
import { sanitizeHtml } from '../common/utils/sanitize.util';
import { getRequestContextSnapshot } from '../common/context/request-context';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(AccountHistory)
    private readonly accountHistoryRepository: Repository<AccountHistory>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Lấy thông tin hồ sơ hiện tại của bản thân (GET /api/users/me)
   */
  async getMyProfile(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Không tìm thấy thông tin người dùng');
    }

    return this.mapUserProfile(user);
  }

  /**
   * Cập nhật hồ sơ của chính mình (PATCH /api/users/me - Bài 3.4):
   * - Yêu cầu ít nhất 1 trong 3 trường: fullName, email, phone.
   * - Đổi email bắt buộc kèm currentPassword (sai hoặc thiếu -> 400 Bad Request; trùng email -> 409 Conflict).
   * - Nếu không có trường nào thực sự thay đổi -> trả 200 ngay, không chèn account_history, không tăng profile_version.
   * - Nếu có trường thay đổi -> trong CÙNG 1 database transaction (dưới khóa FOR UPDATE):
   *   (1) Chèn bản chụp giá trị CŨ vào account_history với version = profile_version hiện tại.
   *   (2) Cập nhật giá trị mới và tăng profile_version = profile_version + 1 qua manager.save(User, user)
   *       (đồng thời kích hoạt UserAuditSubscriber ghi USER_UPDATED vào audit_logs cùng transaction).
   */
  async updateMyProfile(userId: string, dto: UpdateProfileDto) {
    const hasFullName = dto.fullName !== undefined;
    const hasEmail = dto.email !== undefined;
    const hasPhone = dto.phone !== undefined;

    if (!hasFullName && !hasEmail && !hasPhone) {
      throw new BadRequestException(
        'Phải cung cấp ít nhất một trường cần cập nhật (fullName, email hoặc phone)',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const user = await manager
        .createQueryBuilder(User, 'user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('Không tìm thấy thông tin người dùng');
      }

      const nextFullName = hasFullName
        ? sanitizeHtml(dto.fullName!.trim())
        : user.full_name;

      if (hasFullName && nextFullName.length < 2) {
        throw new BadRequestException('Họ và tên phải có ít nhất 2 ký tự');
      }

      const nextEmail = hasEmail ? dto.email!.trim().toLowerCase() : user.email;

      const nextPhone = hasPhone ? (dto.phone ?? null) : (user.phone ?? null);

      const isFullNameChanged = nextFullName !== user.full_name;
      const isEmailChanged = nextEmail !== user.email;
      const isPhoneChanged = nextPhone !== (user.phone ?? null);

      // Nếu người dùng gửi yêu cầu đổi email (hoặc thậm chí gửi email kèm currentPassword):
      // đặc biệt khi email thực sự thay đổi, bắt buộc phải xác thực currentPassword
      if (isEmailChanged) {
        if (!dto.currentPassword || dto.currentPassword.length === 0) {
          throw new BadRequestException(
            'Vui lòng nhập mật khẩu hiện tại (currentPassword) để xác nhận thay đổi địa chỉ email',
          );
        }

        const isPasswordValid = await bcrypt.compare(
          dto.currentPassword,
          user.password_hash,
        );
        if (!isPasswordValid) {
          throw new BadRequestException('Mật khẩu hiện tại không chính xác');
        }

        const duplicateUser = await manager.findOne(User, {
          where: { email: nextEmail },
          withDeleted: true,
        });
        if (duplicateUser && duplicateUser.id !== user.id) {
          throw new ConflictException('Email đã tồn tại');
        }
      }

      // Nếu không có trường nào thực sự thay đổi -> trả 200 OK, không lưu lịch sử và không tăng profile_version
      if (!isFullNameChanged && !isEmailChanged && !isPhoneChanged) {
        return this.mapUserProfile(user);
      }

      const context = getRequestContextSnapshot();
      const changedByUserId = context.actorId ?? user.id;

      // 1. TRƯỚC KHI GHI ĐÈ: lưu bản chụp giá trị CŨ vào bảng account_history
      await this.insertProfileHistoryBeforeOverwrite(
        manager,
        user,
        changedByUserId,
      );

      // 2. Cập nhật hồ sơ mới và nâng số phiên bản profile_version + 1
      user.full_name = nextFullName;
      user.email = nextEmail;
      user.phone = nextPhone;
      user.profile_version = (user.profile_version ?? 1) + 1;

      const savedUser = await manager.save(User, user);

      return this.mapUserProfile(savedUser);
    });
  }

  /**
   * Chèn một bản ghi lịch sử phiên bản hồ sơ (account_history) chứa giá trị cũ trước khi ghi đè.
   * Tách thành một phương thức riêng để dễ kiểm thử rollback giữa chừng (Test H3).
   */
  protected async insertProfileHistoryBeforeOverwrite(
    manager: EntityManager,
    oldUser: User,
    changedByUserId: string | null,
  ): Promise<void> {
    await manager.insert(AccountHistory, {
      user_id: oldUser.id,
      version: oldUser.profile_version ?? 1,
      full_name: oldUser.full_name,
      email: oldUser.email,
      phone: oldUser.phone ?? null,
      changed_by_user_id: changedByUserId,
    });
  }

  /**
   * Xem lịch sử phiên bản hồ sơ của một người dùng (phân trang, mặc định mới nhất trước)
   * Dùng chung cho cả GET /api/users/me/profile-history và GET /api/admin/users/:id/profile-history
   */
  async getProfileHistory(
    targetUserId: string,
    query: ProfileHistoryQueryDto,
    allowDeletedUser = false,
  ) {
    const { page = 1, limit = 10, order = 'desc' } = query;

    const user = await this.userRepository.findOne({
      where: { id: targetUserId },
      withDeleted: allowDeletedUser,
    });

    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng');
    }

    const sortDirection = order.toUpperCase() as 'ASC' | 'DESC';

    const qb = this.accountHistoryRepository
      .createQueryBuilder('history')
      .where('history.user_id = :userId', { userId: targetUserId })
      .orderBy('history.version', sortDirection)
      .addOrderBy('history.id', sortDirection)
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      data: items.map((item) => ({
        version: item.version,
        fullName: item.full_name,
        email: item.email,
        phone: item.phone ?? null,
        changedByUserId: item.changed_by_user_id ?? null,
        changedAt: item.created_at,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private mapUserProfile(user: User) {
    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone ?? null,
      profileVersion: user.profile_version ?? 1,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
    };
  }
}
