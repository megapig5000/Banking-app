import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
  InternalServerErrorException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';
import { Account } from '../database/entities/account.entity';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
} from '../database/entities/transaction.entity';
import {
  LedgerEntry,
  LedgerEntryType,
} from '../database/entities/ledger-entry.entity';
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
  canTransition,
  FAILURE_CODE_MAP,
  LOCK_TIMEOUT,
  MAX_DEADLOCK_RETRIES,
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_NUMERIC_OVERFLOW,
  PG_QUERY_CANCELED,
  PG_UNIQUE_VIOLATION,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
  TransactionFailureCode,
} from './transactions.constants';

interface ExpectedIdempotencyPayload {
  type: TransactionType;
  amount: string;
  description: string | null;
  toAccountNumber: string | null;
  originalTransactionId?: string | null;
}

interface LedgerEntryInput {
  accountId: string;
  transactionId: string;
  type: LedgerEntryType;
  amount: string;
  balanceAfter: string;
}

interface PhaseAInitiationResult {
  isReplay: boolean;
  statusCode?: number;
  transactionResponse?: any;
  initiatedTx?: Transaction;
  actorAccountId: string;
  destAccountNumber: string | null;
}

export interface DeadlockStats {
  deadlockDetected: number;
  retrySucceeded: number;
  retryExhausted: number;
}

/**
 * Lỗi nghiệp vụ nội bộ mang sẵn TransactionFailureCode để Pha C ghi nhận chính xác
 */
class BusinessTransactionError extends Error {
  constructor(public readonly failureCode: TransactionFailureCode) {
    super(FAILURE_CODE_MAP[failureCode].message);
    this.name = 'BusinessTransactionError';
  }
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  // Bộ đếm trong bộ nhớ phục vụ theo dõi Deadlock & Retry (Bài 1.4)
  private readonly deadlockStats: DeadlockStats = {
    deadlockDetected: 0,
    retrySucceeded: 0,
    retryExhausted: 0,
  };

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly dataSource: DataSource,
  ) {}

  getDeadlockStats(): DeadlockStats {
    return { ...this.deadlockStats };
  }

  // =========================================================================
  // STATE MACHINE: CHUYỂN TRẠNG THÁI CÓ ĐIỀU KIỆN (BÀI 3.2 & 5.3)
  // =========================================================================

  /**
   * Hàm duy nhất được phép thay đổi cột `status` của bảng `transactions`.
   * Thực hiện đóng dấu có điều kiện: UPDATE ... SET status = :to, updated_at = now() WHERE id = :id AND status = :from
   */
  async transition(
    manager: EntityManager,
    transactionId: string,
    from: TransactionStatus,
    to: TransactionStatus,
    extras?: { failureCode?: TransactionFailureCode | null },
  ): Promise<void> {
    if (!canTransition(from, to)) {
      this.logger.error(
        `[InvalidStateTransition] Chuyển trạng thái không hợp lệ: ${from} -> ${to} (txId: ${transactionId})`,
      );
      throw new ConflictException(
        `Không thể chuyển trạng thái giao dịch từ ${from} sang ${to}`,
      );
    }

    const updateValues: Record<string, any> = {
      status: to,
      updated_at: () => 'now()',
    };

    if (extras && extras.failureCode !== undefined) {
      updateValues.failure_code = extras.failureCode;
    }

    const result = await manager
      .createQueryBuilder()
      .update(Transaction)
      .set(updateValues)
      .where('id = :id AND status = :from', { id: transactionId, from })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException(
        `Trạng thái giao dịch đã thay đổi (không còn ở trạng thái ${from})`,
      );
    }
  }

  // =========================================================================
  // LỊCH SỬ GIAO DỊCH
  // =========================================================================

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
      throw new NotFoundException('Không tìm thấy tài khoản ngân hàng của bạn');
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

  // =========================================================================
  // 3 NGHIỆP VỤ GIAO DỊCH THEO LUỒNG 3 PHA (PHA A -> PHA B -> PHA C)
  // =========================================================================

  async transfer(userId: string, idempotencyKey: string, dto: TransferDto) {
    this.validatePositiveAmount(dto.amount);
    const sanitizedDesc = sanitizeHtml(dto.description || '') || null;
    const expectedPayload: ExpectedIdempotencyPayload = {
      type: TransactionType.TRANSFER,
      amount: dto.amount,
      description: sanitizedDesc,
      toAccountNumber: dto.toAccountNumber,
    };

    // PHA A: Kiểm tra đầu vào, tra Idempotency, tạo phiếu INITIATED -> PROCESSING và COMMIT ngay
    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      expectedPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;

    // PHA B: Xử lý biến động số dư, ghi sổ cái và đóng dấu PROCESSING -> COMPLETED trong 1 transaction
    try {
      const completedTx = await this.executeWithDeadlockRetry(
        TransactionType.TRANSFER,
        async () => {
          const queryRunner = await this.startTransactionWithLockTimeout();
          try {
            const { actorAccount, destAccount } =
              await this.loadAccountsForTransaction(
                queryRunner.manager,
                userId,
                dto.toAccountNumber,
              );
            this.validateActorAccount(actorAccount);
            const validDest = this.validateDestinationAccountInPhaseB(
              destAccount,
              actorAccount,
            );
            this.ensureSufficientLockedBalance(
              actorAccount.balance,
              dto.amount,
            );

            const senderBalanceAfter = await this.debitAccount(
              queryRunner.manager,
              actorAccount.id,
              dto.amount,
            );

            const receiverBalanceAfter = await this.creditAccount(
              queryRunner.manager,
              validDest.id,
              dto.amount,
            );

            await this.insertLedgerEntries(queryRunner.manager, [
              {
                accountId: actorAccount.id,
                transactionId: initiatedTx.id,
                type: LedgerEntryType.DEBIT,
                amount: initiatedTx.amount,
                balanceAfter: senderBalanceAfter,
              },
              {
                accountId: validDest.id,
                transactionId: initiatedTx.id,
                type: LedgerEntryType.CREDIT,
                amount: initiatedTx.amount,
                balanceAfter: receiverBalanceAfter,
              },
            ]);

            // Đóng dấu PROCESSING -> COMPLETED ngay trong cùng transaction với việc chuyển tiền
            await this.transition(
              queryRunner.manager,
              initiatedTx.id,
              TransactionStatus.PROCESSING,
              TransactionStatus.COMPLETED,
            );

            await queryRunner.commitTransaction();

            initiatedTx.status = TransactionStatus.COMPLETED;
            return initiatedTx;
          } catch (err: any) {
            if (queryRunner.isTransactionActive) {
              await queryRunner.rollbackTransaction();
            }
            throw err;
          } finally {
            await queryRunner.release();
          }
        },
      );

      return {
        statusCode: HttpStatus.CREATED,
        transaction: this.mapTransactionResponse(
          completedTx,
          'outgoing',
          phaseA.destAccountNumber,
        ),
      };
    } catch (phaseBError: any) {
      // PHA C: Sau khi Pha B đã rollback, mở transaction ngắn ghi nhận PROCESSING -> FAILED kèm failure_code
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(initiatedTx.id, failureCode);
      this.throwFailureException(failureCode);
    }
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

    // PHA A
    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      expectedPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;

    // PHA B
    try {
      const completedTx = await this.executeWithDeadlockRetry(
        TransactionType.DEPOSIT,
        async () => {
          const queryRunner = await this.startTransactionWithLockTimeout();
          try {
            const { actorAccount } = await this.loadAccountsForTransaction(
              queryRunner.manager,
              userId,
            );
            this.validateActorAccount(actorAccount);

            const balanceAfter = await this.creditAccount(
              queryRunner.manager,
              actorAccount.id,
              dto.amount,
            );

            await this.insertLedgerEntries(queryRunner.manager, [
              {
                accountId: actorAccount.id,
                transactionId: initiatedTx.id,
                type: LedgerEntryType.CREDIT,
                amount: initiatedTx.amount,
                balanceAfter,
              },
            ]);

            await this.transition(
              queryRunner.manager,
              initiatedTx.id,
              TransactionStatus.PROCESSING,
              TransactionStatus.COMPLETED,
            );

            await queryRunner.commitTransaction();

            initiatedTx.status = TransactionStatus.COMPLETED;
            return initiatedTx;
          } catch (err: any) {
            if (queryRunner.isTransactionActive) {
              await queryRunner.rollbackTransaction();
            }
            throw err;
          } finally {
            await queryRunner.release();
          }
        },
      );

      return {
        statusCode: HttpStatus.CREATED,
        transaction: this.mapTransactionResponse(completedTx, 'incoming', null),
      };
    } catch (phaseBError: any) {
      // PHA C
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(initiatedTx.id, failureCode);
      this.throwFailureException(failureCode);
    }
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

    // PHA A
    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      expectedPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;

    // PHA B
    try {
      const completedTx = await this.executeWithDeadlockRetry(
        TransactionType.WITHDRAW,
        async () => {
          const queryRunner = await this.startTransactionWithLockTimeout();
          try {
            const { actorAccount } = await this.loadAccountsForTransaction(
              queryRunner.manager,
              userId,
            );
            this.validateActorAccount(actorAccount);
            this.ensureSufficientLockedBalance(
              actorAccount.balance,
              dto.amount,
            );

            const balanceAfter = await this.debitAccount(
              queryRunner.manager,
              actorAccount.id,
              dto.amount,
            );

            await this.insertLedgerEntries(queryRunner.manager, [
              {
                accountId: actorAccount.id,
                transactionId: initiatedTx.id,
                type: LedgerEntryType.DEBIT,
                amount: initiatedTx.amount,
                balanceAfter,
              },
            ]);

            await this.transition(
              queryRunner.manager,
              initiatedTx.id,
              TransactionStatus.PROCESSING,
              TransactionStatus.COMPLETED,
            );

            await queryRunner.commitTransaction();

            initiatedTx.status = TransactionStatus.COMPLETED;
            return initiatedTx;
          } catch (err: any) {
            if (queryRunner.isTransactionActive) {
              await queryRunner.rollbackTransaction();
            }
            throw err;
          } finally {
            await queryRunner.release();
          }
        },
      );

      return {
        statusCode: HttpStatus.CREATED,
        transaction: this.mapTransactionResponse(completedTx, 'outgoing', null),
      };
    } catch (phaseBError: any) {
      // PHA C
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(initiatedTx.id, failureCode);
      this.throwFailureException(failureCode);
    }
  }

  // =========================================================================
  // CHI TIẾT PHA A, PHA C & XỬ LÝ REPLAY THEO TRẠNG THÁI
  // =========================================================================

  /**
   * PHA A: Mở transaction ngắn để kiểm tra Idempotency, kiểm tra sự tồn tại của tài khoản đích (404)
   * và chặn tự chuyển tiền cho chính mình (400), sau đó INSERT phiếu (INITIATED -> PROCESSING) và COMMIT ngay.
   */
  private async initiateTransactionPhaseA(
    userId: string,
    idempotencyKey: string,
    expected: ExpectedIdempotencyPayload,
  ): Promise<PhaseAInitiationResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let actorAccountId: string | null = null;

    try {
      const actorAccount = await queryRunner.manager.findOne(Account, {
        where: { user_id: userId },
        relations: { user: true },
      });
      this.validateActorAccount(actorAccount);
      actorAccountId = actorAccount.id;

      // 1. Kiểm tra Idempotency-Key trước khi tạo phiếu
      const existingTx = await this.findExistingByIdempotencyKey(
        queryRunner.manager,
        actorAccountId,
        idempotencyKey,
      );
      if (existingTx) {
        await queryRunner.rollbackTransaction();
        const replay = this.resolveIdempotencyReplay(
          existingTx,
          actorAccountId,
          expected,
        );
        return {
          isReplay: true,
          statusCode: replay.statusCode,
          transactionResponse: replay.transaction,
          actorAccountId,
          destAccountNumber: expected.toAccountNumber,
        };
      }

      // 2. Xác định from_account_id và to_account_id theo loại giao dịch
      // Các lỗi "yêu cầu sai" (404 tài khoản đích không tồn tại, 400 tự chuyển cho chính mình)
      // được chặn ngay tại đây trước khi lập phiếu (không lưu vào DB).
      let fromAccountId: string | null = null;
      let toAccountId: string | null = null;
      let destAccountNumber: string | null = null;

      if (expected.type === TransactionType.TRANSFER) {
        const destAccount = await queryRunner.manager.findOne(Account, {
          where: { account_number: expected.toAccountNumber! },
        });
        if (!destAccount) {
          throw new NotFoundException('Tài khoản đích không tồn tại');
        }
        if (destAccount.id === actorAccount.id) {
          throw new BadRequestException(
            'Không thể tự chuyển tiền cho chính mình',
          );
        }
        fromAccountId = actorAccount.id;
        toAccountId = destAccount.id;
        destAccountNumber = destAccount.account_number;
      } else if (expected.type === TransactionType.DEPOSIT) {
        fromAccountId = null;
        toAccountId = actorAccount.id;
      } else if (expected.type === TransactionType.WITHDRAW) {
        fromAccountId = actorAccount.id;
        toAccountId = null;
      }

      // 3. Tạo bản ghi ở trạng thái INITIATED rồi chuyển sang PROCESSING bằng transition()
      const createdTx = queryRunner.manager.create(Transaction, {
        actor_account_id: actorAccount.id,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        original_transaction_id: expected.originalTransactionId ?? null,
        amount: expected.amount,
        type: expected.type,
        status: TransactionStatus.INITIATED,
        failure_code: null,
        description: expected.description,
        idempotency_key: idempotencyKey,
      });

      const savedTx = await queryRunner.manager.save(createdTx);

      await this.transition(
        queryRunner.manager,
        savedTx.id,
        TransactionStatus.INITIATED,
        TransactionStatus.PROCESSING,
      );
      savedTx.status = TransactionStatus.PROCESSING;

      await queryRunner.commitTransaction();

      return {
        isReplay: false,
        initiatedTx: savedTx,
        actorAccountId,
        destAccountNumber,
      };
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      // Nếu 2 request cùng Idempotency-Key chạy đồng thời đụng Unique Index (23505) ở Pha A:
      // Sau khi đã rollback, dùng chính queryRunner.manager đọc lại phiếu đã được tạo và áp dụng bảng Replay.
      if (actorAccountId && error?.code === PG_UNIQUE_VIOLATION) {
        const existingTx = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          actorAccountId,
          idempotencyKey,
        );
        if (existingTx) {
          const replay = this.resolveIdempotencyReplay(
            existingTx,
            actorAccountId,
            expected,
          );
          return {
            isReplay: true,
            statusCode: replay.statusCode,
            transactionResponse: replay.transaction,
            actorAccountId,
            destAccountNumber: expected.toAccountNumber,
          };
        }
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * PHA C: Mở một transaction ngắn hoàn toàn mới (sau khi Pha B đã rollback)
   * để đóng dấu PROCESSING -> FAILED kèm failure_code.
   */
  private async recordFailedTransactionPhaseC(
    transactionId: string,
    failureCode: TransactionFailureCode,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.transition(
        queryRunner.manager,
        transactionId,
        TransactionStatus.PROCESSING,
        TransactionStatus.FAILED,
        { failureCode },
      );
      await queryRunner.commitTransaction();
    } catch (phaseCError: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      // Nếu chính Pha C thất bại (ví dụ mất kết nối DB), ghi log để job quét giao dịch treo xử lý sau
      this.logger.error(
        `[PhaseCFailure] Không thể ghi nhận trạng thái FAILED cho giao dịch ${transactionId}: ${phaseCError?.message}`,
      );
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Phân loại mọi lỗi phát sinh trong Pha B về đúng TransactionFailureCode chuẩn
   */
  private classifyPhaseBFailure(error: any): TransactionFailureCode {
    if (error instanceof BusinessTransactionError) {
      return error.failureCode;
    }

    if (
      error?.code === PG_LOCK_NOT_AVAILABLE ||
      error?.code === PG_QUERY_CANCELED ||
      error?.code === PG_DEADLOCK_DETECTED ||
      error instanceof ServiceUnavailableException
    ) {
      return TransactionFailureCode.SERVER_BUSY;
    }

    if (error?.code === PG_NUMERIC_OVERFLOW) {
      return TransactionFailureCode.AMOUNT_OVERFLOW;
    }

    this.logger.error(
      `[PhaseBUnexpectedError] Lỗi bất ngờ trong Pha B: ${error?.message || error}`,
    );
    return TransactionFailureCode.INTERNAL_ERROR;
  }

  /**
   * Ném HTTP Exception tương ứng từ bảng FAILURE_CODE_MAP duy nhất
   */
  private throwFailureException(failureCode: TransactionFailureCode): never {
    const def =
      FAILURE_CODE_MAP[failureCode] ??
      FAILURE_CODE_MAP[TransactionFailureCode.INTERNAL_ERROR];

    switch (def.httpStatus) {
      case HttpStatus.UNPROCESSABLE_ENTITY:
        throw new UnprocessableEntityException(def.message);
      case HttpStatus.SERVICE_UNAVAILABLE:
        throw new ServiceUnavailableException(def.message);
      default:
        throw new HttpException(def.message, def.httpStatus);
    }
  }

  /**
   * Xử lý Replay Idempotency theo trạng thái hiện tại của giao dịch (Mục V.E):
   * - Khác payload -> 409 Conflict
   * - COMPLETED / REVERSED -> 200 OK kèm giao dịch
   * - INITIATED / PENDING_OTP / PROCESSING -> 202 Accepted kèm giao dịch đang xử lý
   * - FAILED -> Ném lại đúng lỗi cũ theo failure_code
   */
  private resolveIdempotencyReplay(
    existingTx: Transaction,
    actorAccountId: string,
    expected: ExpectedIdempotencyPayload,
  ): { statusCode: number; transaction: any } {
    const isSameType = existingTx.type === expected.type;
    const isSameAmount =
      this.parseDecimalToCents(existingTx.amount) ===
      this.parseDecimalToCents(expected.amount);
    const isSameDesc =
      (existingTx.description || null) === (expected.description || null);
    const existingToAccNum = existingTx.toAccount?.account_number ?? null;
    const isSameDest =
      expected.type !== TransactionType.TRANSFER ||
      existingToAccNum === expected.toAccountNumber;
    const isSameOrig =
      expected.type !== TransactionType.REVERSAL ||
      existingTx.original_transaction_id ===
        (expected.originalTransactionId ?? null);

    if (
      !isSameType ||
      !isSameAmount ||
      !isSameDesc ||
      !isSameDest ||
      !isSameOrig
    ) {
      throw new ConflictException(
        'Idempotency-Key đã được sử dụng với nội dung giao dịch khác',
      );
    }

    if (
      existingTx.status === TransactionStatus.COMPLETED ||
      existingTx.status === TransactionStatus.REVERSED
    ) {
      return {
        statusCode: HttpStatus.OK,
        transaction: this.mapTransactionItem(existingTx, actorAccountId),
      };
    }

    if (existingTx.status === TransactionStatus.FAILED) {
      const code =
        (existingTx.failure_code as TransactionFailureCode) ||
        TransactionFailureCode.INTERNAL_ERROR;
      this.throwFailureException(
        FAILURE_CODE_MAP[code] ? code : TransactionFailureCode.INTERNAL_ERROR,
      );
    }

    // Trạng thái đang xử lý: INITIATED, PENDING_OTP, PROCESSING -> 202 Accepted
    return {
      statusCode: HttpStatus.ACCEPTED,
      transaction: this.mapTransactionItem(existingTx, actorAccountId),
    };
  }

  // =========================================================================
  // CÁC HÀM BƯỚC DÙNG CHUNG TRONG PHA B & DEADLOCK RETRY
  // =========================================================================

  private async executeWithDeadlockRetry<T>(
    txType: TransactionType,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_DEADLOCK_RETRIES; attempt++) {
      try {
        const result = await operation();
        if (attempt > 0) {
          this.deadlockStats.retrySucceeded += 1;
          this.logger.log(
            `[DeadlockRetry] Giao dịch (${txType}) thành công sau lần retry #${attempt} | ` +
              `Counters: ${JSON.stringify(this.deadlockStats)}`,
          );
        }
        return result;
      } catch (error: any) {
        if (error?.code === PG_DEADLOCK_DETECTED) {
          this.deadlockStats.deadlockDetected += 1;

          if (attempt < MAX_DEADLOCK_RETRIES) {
            const delayMs =
              Math.floor(
                Math.random() * (RETRY_DELAY_MAX_MS - RETRY_DELAY_MIN_MS + 1),
              ) + RETRY_DELAY_MIN_MS;
            this.logger.warn(
              `[DeadlockDetected] Phát hiện deadlock (40P01) ở giao dịch (${txType}), ` +
                `chuẩn bị retry #${attempt + 1}/${MAX_DEADLOCK_RETRIES} sau ${delayMs}ms | ` +
                `Counters: ${JSON.stringify(this.deadlockStats)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          this.deadlockStats.retryExhausted += 1;
          this.logger.warn(
            `[DeadlockExhausted] Đã hết ${MAX_DEADLOCK_RETRIES} lần retry cho giao dịch (${txType}) | ` +
              `Counters: ${JSON.stringify(this.deadlockStats)}`,
          );
          throw new BusinessTransactionError(
            TransactionFailureCode.SERVER_BUSY,
          );
        }
        throw error;
      }
    }

    throw new BusinessTransactionError(TransactionFailureCode.SERVER_BUSY);
  }

  private async startTransactionWithLockTimeout(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
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

  private ensureSufficientLockedBalance(
    lockedBalance: string,
    requiredAmount: string,
    failureCode: TransactionFailureCode = TransactionFailureCode.INSUFFICIENT_BALANCE,
  ): void {
    if (
      this.parseDecimalToCents(lockedBalance) <
      this.parseDecimalToCents(requiredAmount)
    ) {
      throw new BusinessTransactionError(failureCode);
    }
  }

  /**
   * Tải và khóa dòng (SELECT ... FOR UPDATE OF "account") cho tất cả account liên quan
   * trong MỘT truy vấn duy nhất, sắp xếp theo account.id ASC.
   */
  private async loadAccountsForTransaction(
    manager: EntityManager,
    userId: string,
    toAccountNumber?: string,
  ): Promise<{ actorAccount: Account | null; destAccount: Account | null }> {
    const qb = manager
      .createQueryBuilder(Account, 'account')
      .innerJoinAndSelect('account.user', 'user')
      .setLock('pessimistic_write', undefined, ['account'])
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

  private validateDestinationAccountInPhaseB(
    destAccount: Account | null,
    sourceAccount: Account,
  ): Account {
    if (!destAccount || sourceAccount.id === destAccount.id) {
      throw new BusinessTransactionError(TransactionFailureCode.INTERNAL_ERROR);
    }
    if (destAccount.user.status !== UserStatus.ACTIVE) {
      throw new BusinessTransactionError(
        TransactionFailureCode.DESTINATION_UNAVAILABLE,
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

  private async debitAccount(
    manager: EntityManager,
    accountId: string,
    amount: string,
    failureCode: TransactionFailureCode = TransactionFailureCode.INSUFFICIENT_BALANCE,
  ): Promise<string> {
    const debitResult = await manager
      .createQueryBuilder()
      .update(Account)
      .set({ balance: () => 'balance - :amount' })
      .where('id = :id AND balance >= :amount', { id: accountId, amount })
      .returning('balance')
      .execute();

    if (debitResult.affected === 0 || !debitResult.raw?.[0]?.balance) {
      throw new BusinessTransactionError(failureCode);
    }

    return String(debitResult.raw[0].balance);
  }

  private async creditAccount(
    manager: EntityManager,
    accountId: string,
    amount: string,
  ): Promise<string> {
    try {
      const creditResult = await manager
        .createQueryBuilder()
        .update(Account)
        .set({ balance: () => 'balance + :amount' })
        .where('id = :id', { id: accountId, amount })
        .returning('balance')
        .execute();

      if (creditResult.affected === 0 || !creditResult.raw?.[0]?.balance) {
        throw new BusinessTransactionError(
          TransactionFailureCode.INTERNAL_ERROR,
        );
      }

      return String(creditResult.raw[0].balance);
    } catch (error: any) {
      if (error?.code === PG_NUMERIC_OVERFLOW) {
        throw new BusinessTransactionError(
          TransactionFailureCode.AMOUNT_OVERFLOW,
        );
      }
      throw error;
    }
  }

  private async insertLedgerEntries(
    manager: EntityManager,
    entries: LedgerEntryInput[],
  ): Promise<void> {
    for (const entry of entries) {
      await manager.insert(LedgerEntry, {
        account_id: entry.accountId,
        transaction_id: entry.transactionId,
        type: entry.type,
        amount: entry.amount,
        balance_after: entry.balanceAfter,
      });
    }
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
