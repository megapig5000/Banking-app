import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../database/entities/transaction.entity';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { AdminAuditLogsQueryDto } from './dto/admin-audit-logs-query.dto';
import { AuditService } from '../audit/audit.service';
import {
  getVietnamDayStart,
  getVietnamNextDayStart,
} from '../common/utils/date.util';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Lấy danh sách người dùng cho Admin (có phân trang, lọc theo status/role, không lộ password_hash)
   */
  async getUsers(query: AdminUsersQueryDto) {
    const { page = 1, limit = 10, status, role, order = 'desc' } = query;

    const qb = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.accounts', 'account');

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
   * Khóa hoặc mở khóa tài khoản người dùng (PATCH /api/admin/users/:id/status):
   * - Không cho phép Admin tự đổi trạng thái của chính mình (400).
   * - Không tìm thấy người dùng -> 404.
   * - Nếu trạng thái không đổi -> trả 200 ngay, không gọi save() để không sinh audit thừa.
   * - Nếu có thay đổi -> gọi manager.save(User, user) bên trong transaction để Subscriber ghi audit cùng transaction.
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
   * Lấy danh sách toàn bộ giao dịch trên hệ thống dưới góc nhìn của Admin
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

  private mapAdminUserItem(user: User) {
    const primaryAccount =
      Array.isArray(user.accounts) && user.accounts.length > 0
        ? user.accounts[0]
        : null;

    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      accountNumber: primaryAccount?.account_number ?? null,
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
