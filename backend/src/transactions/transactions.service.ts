import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
  InternalServerErrorException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { Account } from '../database/entities/account.entity';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
} from '../database/entities/transaction.entity';
import { UserStatus } from '../database/entities/user.entity';
import { TransferDto } from './dto/transfer.dto';
import { CashTransactionDto } from './dto/cash-transaction.dto';
import {
  TransactionQueryDto,
  TransactionDirection,
} from './dto/transaction-query.dto';
import { sanitizeHtml } from '../common/utils/sanitize.util';
import {
  getVietnamDayStart,
  getVietnamNextDayStart,
} from '../common/utils/date.util';
import {
  MAX_OPTIMISTIC_RETRIES,
  PG_NUMERIC_OVERFLOW,
  PG_UNIQUE_VIOLATION,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
} from './transactions.constants';

interface ExpectedIdempotencyPayload {
  type: TransactionType;
  amount: string;
  description: string | null;
  toAccountNumber: string | null;
}

class OptimisticLockConflictError extends Error {
  constructor() {
    super('Optimistic lock version conflict');
  }
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly dataSource: DataSource,
  ) {}

  async getTransactions(userId: string, query: TransactionQueryDto) {
    const {
      page = 1,
      limit = 10,
      direction,
      fromDate,
      toDate,
      order = 'desc',
    } = query;

    if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
      throw new BadRequestException('fromDate không được lớn hơn toDate');
    }

    const account = await this.accountRepository.findOne({
      where: { user_id: userId },
    });
    if (!account) {
      throw new NotFoundException(
        'Không tìm thấy tài khoản ngân hàng của bạn',
      );
    }
    const accountId = account.id;

    const qb = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.fromAccount', 'fromAccount')
      .leftJoinAndSelect('transaction.toAccount', 'toAccount');

    if (direction === TransactionDirection.INCOMING) {
      qb.andWhere('transaction.to_account_id = :accountId', { accountId });
    } else if (direction === TransactionDirection.OUTGOING) {
      qb.andWhere('transaction.from_account_id = :accountId', { accountId });
    } else {
      qb.andWhere(
        '(transaction.from_account_id = :accountId OR transaction.to_account_id = :accountId)',
        { accountId },
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

    const data = transactions.map((tx) =>
      this.mapTransactionItem(tx, accountId),
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

  async transfer(userId: string, idempotencyKey: string, dto: TransferDto) {
    this.validatePositiveAmount(dto.amount);
    const sanitizedDesc = sanitizeHtml(dto.description || '') || null;
    const expectedPayload: ExpectedIdempotencyPayload = {
      type: TransactionType.TRANSFER,
      amount: dto.amount,
      description: sanitizedDesc,
      toAccountNumber: dto.toAccountNumber,
    };

    return this.executeWithOptimisticRetry(async () => {
      const queryRunner = await this.startNewTransaction();
      let actorAccountId: string | null = null;

      try {
        // 1. Đọc tài khoản KHÔNG khóa (Optimistic)
        const { actorAccount, destAccount } =
          await this.loadAccountsForTransaction(
            queryRunner.manager,
            userId,
            dto.toAccountNumber,
          );
        this.validateActorAccount(actorAccount);
        actorAccountId = actorAccount.id;

        // 2. Kiểm tra Idempotency-Key
        const existingTx = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          actorAccountId,
          idempotencyKey,
        );
        if (existingTx) {
          await queryRunner.rollbackTransaction();
          return this.resolveIdempotencyReplay(
            existingTx,
            actorAccountId,
            expectedPayload,
          );
        }

        // 3. Kiểm tra tài khoản đích & số dư đã đọc
        const validDest = this.validateDestinationAccount(
          destAccount,
          actorAccount,
        );
        this.ensureSufficientBalance(actorAccount.balance, dto.amount);

        // 4. Trừ tiền kèm kiểm tra version của tài khoản nguồn
        await this.debitAccountOptimistic(
          queryRunner.manager,
          actorAccount.id,
          actorAccount.version,
          dto.amount,
        );

        // 5. Cộng tiền kèm kiểm tra version của tài khoản đích
        await this.creditAccountOptimistic(
          queryRunner.manager,
          validDest.id,
          validDest.version,
          dto.amount,
        );

        // 6. Ghi bản ghi giao dịch
        const savedTx = await this.insertTransactionRecord(
          queryRunner.manager,
          {
            actorAccountId: actorAccount.id,
            fromAccountId: actorAccount.id,
            toAccountId: validDest.id,
            amount: dto.amount,
            type: TransactionType.TRANSFER,
            description: sanitizedDesc,
            idempotencyKey,
          },
        );

        await queryRunner.commitTransaction();

        return {
          isReplay: false,
          transaction: this.mapTransactionResponse(
            savedTx,
            'outgoing',
            validDest.account_number,
          ),
        };
      } catch (error: any) {
        return await this.handleTransactionError(
          queryRunner,
          error,
          actorAccountId,
          idempotencyKey,
          expectedPayload,
        );
      } finally {
        await queryRunner.release();
      }
    });
  }

  async deposit(
    userId: string,
    idempotencyKey: string,
    dto: CashTransactionDto,
  ) {
    this.validatePositiveAmount(dto.amount);
    const sanitizedDesc = sanitizeHtml(dto.description || '') || null;
    const expectedPayload: ExpectedIdempotencyPayload = {
      type: TransactionType.DEPOSIT,
      amount: dto.amount,
      description: sanitizedDesc,
      toAccountNumber: null,
    };

    return this.executeWithOptimisticRetry(async () => {
      const queryRunner = await this.startNewTransaction();
      let actorAccountId: string | null = null;

      try {
        const { actorAccount } = await this.loadAccountsForTransaction(
          queryRunner.manager,
          userId,
        );
        this.validateActorAccount(actorAccount);
        actorAccountId = actorAccount.id;

        const existingTx = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          actorAccountId,
          idempotencyKey,
        );
        if (existingTx) {
          await queryRunner.rollbackTransaction();
          return this.resolveIdempotencyReplay(
            existingTx,
            actorAccountId,
            expectedPayload,
          );
        }

        await this.creditAccountOptimistic(
          queryRunner.manager,
          actorAccount.id,
          actorAccount.version,
          dto.amount,
        );

        const savedTx = await this.insertTransactionRecord(
          queryRunner.manager,
          {
            actorAccountId: actorAccount.id,
            fromAccountId: null,
            toAccountId: actorAccount.id,
            amount: dto.amount,
            type: TransactionType.DEPOSIT,
            description: sanitizedDesc,
            idempotencyKey,
          },
        );

        await queryRunner.commitTransaction();

        return {
          isReplay: false,
          transaction: this.mapTransactionResponse(savedTx, 'incoming', null),
        };
      } catch (error: any) {
        return await this.handleTransactionError(
          queryRunner,
          error,
          actorAccountId,
          idempotencyKey,
          expectedPayload,
        );
      } finally {
        await queryRunner.release();
      }
    });
  }

  async withdraw(
    userId: string,
    idempotencyKey: string,
    dto: CashTransactionDto,
  ) {
    this.validatePositiveAmount(dto.amount);
    const sanitizedDesc = sanitizeHtml(dto.description || '') || null;
    const expectedPayload: ExpectedIdempotencyPayload = {
      type: TransactionType.WITHDRAW,
      amount: dto.amount,
      description: sanitizedDesc,
      toAccountNumber: null,
    };

    return this.executeWithOptimisticRetry(async () => {
      const queryRunner = await this.startNewTransaction();
      let actorAccountId: string | null = null;

      try {
        // 1. Đọc tài khoản KHÔNG khóa (lấy cả balance và version hiện tại)
        const { actorAccount } = await this.loadAccountsForTransaction(
          queryRunner.manager,
          userId,
        );
        this.validateActorAccount(actorAccount);
        actorAccountId = actorAccount.id;

        // 2. Kiểm tra Idempotency-Key
        const existingTx = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          actorAccountId,
          idempotencyKey,
        );
        if (existingTx) {
          await queryRunner.rollbackTransaction();
          return this.resolveIdempotencyReplay(
            existingTx,
            actorAccountId,
            expectedPayload,
          );
        }

        // 3. Kiểm tra số dư từ dữ liệu vừa đọc
        this.ensureSufficientBalance(actorAccount.balance, dto.amount);

        // 4. Trừ tiền kèm điều kiện WHERE version = :expectedVersion
        await this.debitAccountOptimistic(
          queryRunner.manager,
          actorAccount.id,
          actorAccount.version,
          dto.amount,
        );

        // 5. Ghi bản ghi giao dịch
        const savedTx = await this.insertTransactionRecord(
          queryRunner.manager,
          {
            actorAccountId: actorAccount.id,
            fromAccountId: actorAccount.id,
            toAccountId: null,
            amount: dto.amount,
            type: TransactionType.WITHDRAW,
            description: sanitizedDesc,
            idempotencyKey,
          },
        );

        await queryRunner.commitTransaction();

        return {
          isReplay: false,
          transaction: this.mapTransactionResponse(savedTx, 'outgoing', null),
        };
      } catch (error: any) {
        return await this.handleTransactionError(
          queryRunner,
          error,
          actorAccountId,
          idempotencyKey,
          expectedPayload,
        );
      } finally {
        await queryRunner.release();
      }
    });
  }

  // =========================================================================
  // VÒNG LẶP RETRY BAO NGOÀI TRANSACTION CHO OPTIMISTIC LOCKING
  // =========================================================================

  /**
   * Mỗi lần gặp xung đột version, transaction cũ đã được rollback và đóng lại;
   * hàm này chờ một khoảng ngắn ngẫu nhiên rồi chạy lại toàn bộ hàm operation
   * trong một Database Transaction hoàn toàn mới.
   */
  private async executeWithOptimisticRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof OptimisticLockConflictError) {
          if (attempt < MAX_OPTIMISTIC_RETRIES) {
            const delayMs =
              Math.floor(
                Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1),
              ) + RETRY_DELAY_MIN_MS;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
          throw new ServiceUnavailableException(
            'Hệ thống đang bận do xung đột giao dịch, vui lòng thử lại',
          );
        }
        throw error;
      }
    }
    throw new ServiceUnavailableException(
      'Hệ thống đang bận do xung đột giao dịch, vui lòng thử lại',
    );
  }

  private async startNewTransaction(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    return queryRunner;
  }

  private validatePositiveAmount(amount: string): void {
    if (this.parseDecimalToCents(amount) <= 0n) {
      throw new BadRequestException('Số tiền giao dịch phải lớn hơn 0');
    }
  }

  private parseDecimalToCents(decimalStr: string): bigint {
    const trimmed = decimalStr.trim();
    const isNegative = trimmed.startsWith('-');
    const normalized = isNegative ? trimmed.slice(1) : trimmed;
    const [intPart = '0', fracPart = ''] = normalized.split('.');
    const paddedFrac = (fracPart + '00').slice(0, 2);
    const cents = BigInt(intPart) * 100n + BigInt(paddedFrac);
    return isNegative ? -cents : cents;
  }

  private ensureSufficientBalance(
    currentBalance: string,
    requiredAmount: string,
  ): void {
    if (
      this.parseDecimalToCents(currentBalance) <
      this.parseDecimalToCents(requiredAmount)
    ) {
      throw new UnprocessableEntityException('Không đủ số dư khả dụng');
    }
  }

  /**
   * Ở nhánh Optimistic: đọc account bằng SELECT thường (KHÔNG có setLock('pessimistic_write'))
   */
  private async loadAccountsForTransaction(
    manager: EntityManager,
    userId: string,
    toAccountNumber?: string,
  ): Promise<{ actorAccount: Account | null; destAccount: Account | null }> {
    const qb = manager
      .createQueryBuilder(Account, 'account')
      .innerJoinAndSelect('account.user', 'user')
      .where('account.user_id = :userId', { userId });

    if (toAccountNumber) {
      qb.orWhere('account.account_number = :toAccountNumber', {
        toAccountNumber,
      });
    }

    const accounts = await qb.orderBy('account.id', 'ASC').getMany();

    const actorAccount = accounts.find((a) => a.user_id === userId) ?? null;
    const destAccount = toAccountNumber
      ? (accounts.find((a) => a.account_number === toAccountNumber) ?? null)
      : null;

    return { actorAccount, destAccount };
  }

  private validateActorAccount(
    actorAccount: Account | null,
  ): asserts actorAccount is Account {
    if (!actorAccount) {
      throw new NotFoundException('Không tìm thấy tài khoản nguồn');
    }
    if (actorAccount.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Tài khoản của bạn đã bị khóa');
    }
  }

  private validateDestinationAccount(
    destAccount: Account | null,
    sourceAccount: Account,
  ): Account {
    if (!destAccount) {
      throw new NotFoundException('Tài khoản đích không tồn tại');
    }
    if (destAccount.user.status !== UserStatus.ACTIVE) {
      throw new UnprocessableEntityException(
        'Tài khoản đích đang bị khóa, không thể nhận tiền',
      );
    }
    if (sourceAccount.id === destAccount.id) {
      throw new BadRequestException(
        'Không thể tự chuyển tiền cho chính mình',
      );
    }
    return destAccount;
  }

  private async findExistingByIdempotencyKey(
    manager: EntityManager,
    actorAccountId: string,
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    return manager.findOne(Transaction, {
      where: {
        idempotency_key: idempotencyKey,
        actor_account_id: actorAccountId,
      },
      relations: { fromAccount: true, toAccount: true },
    });
  }

  private resolveIdempotencyReplay(
    existingTx: Transaction,
    actorAccountId: string,
    expected: ExpectedIdempotencyPayload,
  ) {
    const isSameType = existingTx.type === expected.type;
    const isSameAmount =
      this.parseDecimalToCents(existingTx.amount) ===
      this.parseDecimalToCents(expected.amount);
    const isSameDesc =
      (existingTx.description || null) === (expected.description || null);
    const existingToAccNum = existingTx.toAccount?.account_number ?? null;
    const isSameDest = existingToAccNum === expected.toAccountNumber;

    if (isSameType && isSameAmount && isSameDesc && isSameDest) {
      return {
        isReplay: true,
        transaction: this.mapTransactionItem(existingTx, actorAccountId),
      };
    }

    throw new ConflictException(
      'Idempotency-Key đã được sử dụng với nội dung giao dịch khác',
    );
  }

  /**
   * Trừ tiền với Optimistic Lock: kiểm tra WHERE version = :expectedVersion và tăng version + 1.
   * Nếu affected === 0 -> đã có transaction khác sửa dòng này -> ném OptimisticLockConflictError để retry.
   */
  private async debitAccountOptimistic(
    manager: EntityManager,
    accountId: string,
    expectedVersion: number,
    amount: string,
  ): Promise<void> {
    const debitResult = await manager
      .createQueryBuilder()
      .update(Account)
      .set({
        balance: () => 'balance - :amount',
        version: () => 'version + 1',
      })
      .where('id = :id AND version = :expectedVersion AND balance >= :amount', {
        id: accountId,
        expectedVersion,
        amount,
      })
      .execute();

    if (debitResult.affected === 0) {
      throw new OptimisticLockConflictError();
    }
  }

  /**
   * Cộng tiền với Optimistic Lock: kiểm tra WHERE version = :expectedVersion và tăng version + 1.
   */
  private async creditAccountOptimistic(
    manager: EntityManager,
    accountId: string,
    expectedVersion: number,
    amount: string,
  ): Promise<void> {
    try {
      const creditResult = await manager
        .createQueryBuilder()
        .update(Account)
        .set({
          balance: () => 'balance + :amount',
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :expectedVersion', {
          id: accountId,
          expectedVersion,
          amount, // <-- Bắt buộc truyền amount cho biểu thức 'balance + :amount' ở .set()
        })
        .execute();

      if (creditResult.affected === 0) {
        throw new OptimisticLockConflictError();
      }
    } catch (error: any) {
      if (error.code === PG_NUMERIC_OVERFLOW) {
        throw new UnprocessableEntityException(
          'Số dư tài khoản vượt quá giới hạn cho phép',
        );
      }
      throw error;
    }
  }

  private async insertTransactionRecord(
    manager: EntityManager,
    params: {
      actorAccountId: string;
      fromAccountId: string | null;
      toAccountId: string | null;
      amount: string;
      type: TransactionType;
      description: string | null;
      idempotencyKey: string;
    },
  ): Promise<Transaction> {
    const tx = manager.create(Transaction, {
      actor_account_id: params.actorAccountId,
      from_account_id: params.fromAccountId,
      to_account_id: params.toAccountId,
      amount: params.amount,
      type: params.type,
      status: TransactionStatus.SUCCESS,
      description: params.description,
      idempotency_key: params.idempotencyKey,
    });

    return manager.save(tx);
  }

  private async handleTransactionError(
    queryRunner: QueryRunner,
    error: any,
    actorAccountId: string | null,
    idempotencyKey: string,
    expectedPayload: ExpectedIdempotencyPayload,
  ): Promise<never | { isReplay: boolean; transaction: any }> {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }


    // Nếu là xung đột version -> ném tiếp ra ngoài để executeWithOptimisticRetry thử lại
    if (error instanceof OptimisticLockConflictError) {
      throw error;
    }

    if (actorAccountId && error.code === PG_UNIQUE_VIOLATION) {
      const existingTx = await this.findExistingByIdempotencyKey(
        queryRunner.manager,
        actorAccountId,
        idempotencyKey,
      );

      if (existingTx) {
        return this.resolveIdempotencyReplay(
          existingTx,
          actorAccountId,
          expectedPayload,
        );
      }
    }

    if (error.status) {
      throw error;
    }

    console.error('Transaction Error:', error);
    throw new InternalServerErrorException(
      'Lỗi hệ thống khi thực hiện giao dịch',
    );
  }

  private mapTransactionItem(tx: Transaction, currentAccountId: string) {
    const isIncoming = tx.to_account_id === currentAccountId;
    const counterpartyAccountNumber = isIncoming
      ? (tx.fromAccount?.account_number ?? null)
      : (tx.toAccount?.account_number ?? null);

    return this.mapTransactionResponse(
      tx,
      isIncoming ? 'incoming' : 'outgoing',
      counterpartyAccountNumber,
    );
  }

  private mapTransactionResponse(
    tx: Transaction,
    direction: 'incoming' | 'outgoing',
    counterpartyAccountNumber: string | null,
  ) {
    return {
      id: tx.id,
      amount: tx.amount,
      type: tx.type,
      status: tx.status,
      description: tx.description,
      createdAt: tx.created_at,
      direction,
      counterpartyAccountNumber,
    };
  }
}