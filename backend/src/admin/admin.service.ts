import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { User, UserRole } from '../database/entities/user.entity';
import { Account, AccountStatus } from '../database/entities/account.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../database/entities/transaction.entity';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateAccountAdminDto } from './dto/update-account-admin.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { AdminAuditLogsQueryDto } from './dto/admin-audit-logs-query.dto';
import { ProfileHistoryQueryDto } from '../users/dto/profile-history-query.dto';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { normalizeAuditDecimal } from '../audit/audit.constants';
import {
  formatCentsToDecimal,
  getVietnamDayStart,
  getVietnamNextDayStart,
  parseDecimalToCents,
} from '../common/utils/date.util';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Lấy danh sách người dùng cho Admin (có phân trang, lọc theo status/role, hỗ trợ includeDeleted, không lộ password_hash)
   */
  async getUsers(query: AdminUsersQueryDto) {
    const {
      page = 1,
      limit = 10,
      status,
      role,
      includeDeleted = false,
      order = 'desc',
    } = query;

    const qb = this.userRepository.createQueryBuilder('user');

    // Phải bật .withDeleted() TRƯỚC khi gọi .leftJoinAndSelect('user.accounts', 'account')
    // để TypeORM không gắn điều kiện "AND account.deleted_at IS NULL" vào mệnh đề ON của LEFT JOIN
    if (includeDeleted) {
      qb.withDeleted();
    }

    qb.leftJoinAndSelect('user.accounts', 'account');

    if (status) {
      qb.andWhere('user.status = :status', { status });
    }

    if (role) {
      qb.andWhere('user.role = :role', { role });
    }

    const sortDirection = order.toUpperCase() as 'ASC' | 'DESC';
    qb.orderBy('user.created_at', sortDirection).addOrderBy(
      'user.id',
      sortDirection,
    );

    qb.skip((page - 1) * limit).take(limit);

    const [users, total] = await qb.getManyAndCount();

    return {
      data: users.map((u) => this.mapAdminUserItem(u)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Xem lịch sử phiên bản hồ sơ của bất kỳ người dùng nào (GET /api/admin/users/:id/profile-history - Chỉ ADMIN)
   */
  async getUserProfileHistory(
    targetUserId: string,
    query: ProfileHistoryQueryDto,
  ) {
    return this.usersService.getProfileHistory(targetUserId, query, true);
  }

  /**
   * Khóa hoặc mở khóa tài khoản người dùng (PATCH /api/admin/users/:id/status)
   */
  async updateUserStatus(
    adminUserId: string,
    targetUserId: string,
    dto: UpdateUserStatusDto,
  ) {
    if (adminUserId === targetUserId) {
      throw new BadRequestException(
        'Bạn không thể tự thay đổi trạng thái khóa của chính mình',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: targetUserId },
        relations: { accounts: true },
      });

      if (!user) {
        throw new NotFoundException('Không tìm thấy người dùng');
      }

      if (user.status === dto.status) {
        return this.mapAdminUserItem(user);
      }

      user.status = dto.status;
      const savedUser = await manager.save(User, user);

      return this.mapAdminUserItem(savedUser);
    });
  }

  /**
   * Xóa mềm người dùng và tài khoản ngân hàng (DELETE /api/admin/users/:id - Bài 3.4)
   */
  async softDeleteUser(
    adminUserId: string,
    targetUserId: string,
  ): Promise<void> {
    if (adminUserId === targetUserId) {
      throw new BadRequestException(
        'Bạn không thể tự xóa tài khoản của chính mình',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: targetUserId },
      });

      if (!user) {
        throw new NotFoundException(
          'Không tìm thấy người dùng hoặc người dùng đã bị xóa',
        );
      }

      if (user.role !== UserRole.CUSTOMER) {
        throw new ForbiddenException(
          'Chỉ được phép xóa mềm người dùng có vai trò CUSTOMER',
        );
      }

      const accounts = await manager
        .createQueryBuilder(Account, 'account')
        .setLock('pessimistic_write', undefined, ['account'])
        .where('account.user_id = :userId', { userId: user.id })
        .orderBy('account.id', 'ASC')
        .getMany();

      for (const account of accounts) {
        const balanceCents = parseDecimalToCents(account.balance);
        const holdCents = parseDecimalToCents(account.hold_amount);

        if (balanceCents !== 0n) {
          throw new ConflictException(
            'Không thể xóa người dùng khi tài khoản vẫn còn số dư lớn hơn 0',
          );
        }

        if (holdCents !== 0n) {
          throw new ConflictException(
            'Không thể xóa người dùng khi tài khoản vẫn còn số tiền phong tỏa (holdAmount) lớn hơn 0',
          );
        }

        const pendingTxCount = await manager
          .createQueryBuilder(Transaction, 'tx')
          .where('(tx.from_account_id = :accId OR tx.to_account_id = :accId)', {
            accId: account.id,
          })
          .andWhere('tx.status IN (:...pendingStatuses)', {
            pendingStatuses: [
              TransactionStatus.INITIATED,
              TransactionStatus.PENDING_OTP,
              TransactionStatus.PROCESSING,
            ],
          })
          .getCount();

        if (pendingTxCount > 0) {
          throw new ConflictException(
            'Không thể xóa người dùng khi tài khoản đang có giao dịch xử lý dở dang',
          );
        }

        if (account.status !== AccountStatus.CLOSED) {
          account.status = AccountStatus.CLOSED;
          await manager.save(Account, account);
        }

        await manager.softRemove(Account, account);
      }

      await manager.softRemove(User, user);
    });
  }

  /**
   * Quản lý tài khoản ngân hàng (PATCH /api/admin/accounts/:accountNumber - Bài 5.2)
   */
  async updateAccount(accountNumber: string, dto: UpdateAccountAdminDto) {
    if (
      dto.status === undefined &&
      dto.tier === undefined &&
      dto.holdAmount === undefined
    ) {
      throw new BadRequestException(
        'Phải cung cấp ít nhất một trường cần cập nhật (status, tier hoặc holdAmount)',
      );
    }

    const normalizedNumber = accountNumber.trim();

    return this.dataSource.transaction(async (manager) => {
      const account = await manager
        .createQueryBuilder(Account, 'account')
        .innerJoinAndSelect('account.user', 'user')
        .setLock('pessimistic_write', undefined, ['account'])
        .where('account.account_number = :accountNumber', {
          accountNumber: normalizedNumber,
        })
        .getOne();

      if (!account) {
        throw new NotFoundException('Không tìm thấy tài khoản ngân hàng');
      }

      if (account.status === AccountStatus.CLOSED && dto.status !== undefined) {
        throw new ConflictException(
          'Tài khoản đã đóng (CLOSED là trạng thái cuối), không thể thay đổi trạng thái',
        );
      }

      const currentBalanceCents = parseDecimalToCents(account.balance);
      const currentHoldCents = parseDecimalToCents(account.hold_amount);

      let nextHoldAmountStr =
        normalizeAuditDecimal(account.hold_amount) ?? '0.00';
      let nextHoldCents = currentHoldCents;

      if (dto.holdAmount !== undefined) {
        nextHoldAmountStr = normalizeAuditDecimal(dto.holdAmount) ?? '0.00';
        nextHoldCents = parseDecimalToCents(nextHoldAmountStr);

        if (nextHoldCents < 0n || nextHoldCents > currentBalanceCents) {
          throw new UnprocessableEntityException(
            'Số tiền phong tỏa (holdAmount) phải từ 0 đến không vượt quá số dư hiện tại của tài khoản',
          );
        }
      }

      if (dto.status === AccountStatus.CLOSED) {
        if (currentBalanceCents !== 0n) {
          throw new ConflictException(
            'Chỉ có thể đóng tài khoản (CLOSED) khi số dư bằng 0',
          );
        }

        if (nextHoldCents !== 0n) {
          throw new ConflictException(
            'Chỉ có thể đóng tài khoản (CLOSED) khi số tiền phong tỏa (holdAmount) bằng 0',
          );
        }

        const pendingTxCount = await manager
          .createQueryBuilder(Transaction, 'tx')
          .where('(tx.from_account_id = :accId OR tx.to_account_id = :accId)', {
            accId: account.id,
          })
          .andWhere('tx.status IN (:...pendingStatuses)', {
            pendingStatuses: [
              TransactionStatus.INITIATED,
              TransactionStatus.PENDING_OTP,
              TransactionStatus.PROCESSING,
            ],
          })
          .getCount();

        if (pendingTxCount > 0) {
          throw new ConflictException(
            'Không thể đóng tài khoản khi đang có giao dịch xử lý dở dang',
          );
        }
      }

      const nextStatus = dto.status ?? account.status;
      const nextTier = dto.tier ?? account.tier;

      const isChanged =
        nextStatus !== account.status ||
        nextTier !== account.tier ||
        nextHoldCents !== currentHoldCents;

      if (!isChanged) {
        return this.mapAdminAccountResponse(account);
      }

      account.status = nextStatus;
      account.tier = nextTier;
      account.hold_amount = nextHoldAmountStr;

      const savedAccount = await manager.save(Account, account);
      savedAccount.user = account.user;

      return this.mapAdminAccountResponse(savedAccount);
    });
  }

  /**
   * Lấy danh sách toàn bộ giao dịch trên hệ thống dưới góc nhìn của Admin.
   */
  async getTransactions(query: AdminTransactionsQueryDto) {
    const {
      page = 1,
      limit = 10,
      status,
      type,
      accountNumber,
      fromDate,
      toDate,
      order = 'desc',
    } = query;

    if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
      throw new BadRequestException('fromDate không được lớn hơn toDate');
    }

    const qb = this.transactionRepository
      .createQueryBuilder('transaction')
      .withDeleted()
      .leftJoinAndSelect('transaction.fromAccount', 'fromAccount')
      .leftJoinAndSelect('transaction.toAccount', 'toAccount');

    if (status) {
      qb.andWhere('transaction.status = :status', { status });
    }

    if (type) {
      qb.andWhere('transaction.type = :type', { type });
    }

    if (accountNumber) {
      qb.andWhere(
        '(fromAccount.account_number = :accountNumber OR toAccount.account_number = :accountNumber)',
        { accountNumber },
      );
    }

    if (fromDate) {
      qb.andWhere('transaction.created_at >= :fromDate', {
        fromDate: getVietnamDayStart(fromDate),
      });
    }

    if (toDate) {
      qb.andWhere('transaction.created_at < :toDate', {
        toDate: getVietnamNextDayStart(toDate),
      });
    }

    const sortDirection = order.toUpperCase() as 'ASC' | 'DESC';
    qb.orderBy('transaction.created_at', sortDirection).addOrderBy(
      'transaction.id',
      sortDirection,
    );

    qb.skip((page - 1) * limit).take(limit);

    const [transactions, total] = await qb.getManyAndCount();

    const reversedIds = transactions
      .filter((tx) => tx.status === TransactionStatus.REVERSED)
      .map((tx) => tx.id);

    const reversalMap = new Map<string, string>();
    if (reversedIds.length > 0) {
      const completedReversals = await this.transactionRepository.find({
        where: {
          original_transaction_id: In(reversedIds),
          type: TransactionType.REVERSAL,
          status: TransactionStatus.COMPLETED,
        },
        select: { id: true, original_transaction_id: true },
      });
      for (const rev of completedReversals) {
        if (rev.original_transaction_id) {
          reversalMap.set(rev.original_transaction_id, rev.id);
        }
      }
    }

    const data = transactions.map((tx) =>
      this.mapAdminTransactionItem(tx, reversalMap.get(tx.id) ?? null),
    );

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Lấy danh sách nhật ký kiểm toán (GET /api/admin/audit-logs - Chỉ dành cho ADMIN)
   */
  async getAuditLogs(query: AdminAuditLogsQueryDto) {
    return this.auditService.getAuditLogs(query);
  }

  private mapAdminAccountResponse(account: Account) {
    const holdAmount = normalizeAuditDecimal(account.hold_amount) ?? '0.00';
    const availableCents =
      parseDecimalToCents(account.balance) - parseDecimalToCents(holdAmount);

    return {
      id: account.id,
      accountNumber: account.account_number,
      balance: account.balance,
      holdAmount,
      availableBalance: formatCentsToDecimal(availableCents),
      status: account.status,
      tier: account.tier,
      currency: account.currency,
      ownerName: account.user?.full_name ?? null,
      createdAt: account.created_at,
    };
  }

  private mapAdminUserItem(user: User) {
    const primaryAccount =
      Array.isArray(user.accounts) && user.accounts.length > 0
        ? user.accounts[0]
        : null;

    const holdAmount = primaryAccount
      ? (normalizeAuditDecimal(primaryAccount.hold_amount) ?? '0.00')
      : null;
    const availableBalance = primaryAccount
      ? formatCentsToDecimal(
          parseDecimalToCents(primaryAccount.balance) -
            parseDecimalToCents(holdAmount ?? '0.00'),
        )
      : null;

    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone ?? null,
      profileVersion: user.profile_version ?? 1,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      deletedAt: user.deleted_at ?? null,
      accountNumber: primaryAccount?.account_number ?? null,
      accountStatus: primaryAccount?.status ?? null,
      accountTier: primaryAccount?.tier ?? null,
      holdAmount,
      availableBalance,
    };
  }

  private mapAdminTransactionItem(
    tx: Transaction,
    reversalTransactionId: string | null = null,
  ) {
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: tx.amount,
      description: tx.description,
      createdAt: tx.created_at,
      fromAccountNumber: tx.fromAccount?.account_number ?? null,
      toAccountNumber: tx.toAccount?.account_number ?? null,
      originalTransactionId: tx.original_transaction_id ?? null,
      reversalTransactionId,
    };
  }
}
