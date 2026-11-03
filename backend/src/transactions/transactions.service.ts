import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryRunner,
  Repository,
} from 'typeorm';
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
import { ReverseTransactionDto } from './dto/reverse-transaction.dto';
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
  // LỊCH SỬ GIAO DỊCH (CÓ originalTransactionId & reversalTransactionId)
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

    // Tải reversalTransactionId cho các giao dịch REVERSED trong trang hiện tại chỉ bằng 1 truy vấn
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
      this.mapTransactionItem(tx, accountId, reversalMap.get(tx.id) ?? null),
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
  // 4 NGHIỆP VỤ GIAO DỊCH THEO LUỒNG 3 PHA (TRANSFER, DEPOSIT, WITHDRAW, REVERSAL)
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
          null,
        ),
      };
    } catch (phaseBError: any) {
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
        transaction: this.mapTransactionResponse(
          completedTx,
          'incoming',
          null,
          null,
        ),
      };
    } catch (phaseBError: any) {
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
        transaction: this.mapTransactionResponse(
          completedTx,
          'outgoing',
          null,
          null,
        ),
      };
    } catch (phaseBError: any) {
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(initiatedTx.id, failureCode);
      this.throwFailureException(failureCode);
    }
  }

  /**
   * Nghiệp vụ Hoàn tiền (REVERSAL - Bài 3.2) dành cho Admin, thực thi theo Luồng 3 Pha:
   * - Pha A: Kiểm tra Idempotency, kiểm tra giao dịch gốc phải là COMPLETED (không phải REVERSAL),
   *   tạo phiếu REVERSAL (INITIATED -> PROCESSING) với chiều tài khoản đảo ngược và COMMIT.
   * - Pha B: Khóa các tài khoản liên quan theo id ASC, đọc bút toán gốc và tạo các bút toán đảo (DEBIT <-> CREDIT),
   *   đóng dấu REVERSAL (PROCESSING -> COMPLETED) VÀ đóng dấu giao dịch gốc (COMPLETED -> REVERSED) trong cùng 1 transaction.
   * - Pha C: Nếu Pha B lỗi (ví dụ bên nhận đã tiêu hết tiền -> REVERSAL_INSUFFICIENT_BALANCE),
   *   đóng dấu phiếu REVERSAL sang FAILED, giao dịch gốc giữ nguyên COMPLETED.
   */
  async reverseTransaction(
    adminUserId: string,
    originalTransactionId: string,
    idempotencyKey: string,
    dto: ReverseTransactionDto,
  ) {
    const sanitizedReason = sanitizeHtml(dto.reason?.trim() || '') || null;
    const reversalDescription = sanitizedReason
      ? `Hoàn tiền giao dịch ${originalTransactionId}: ${sanitizedReason}`.slice(
          0,
          255,
        )
      : `Hoàn tiền giao dịch ${originalTransactionId}`;

    // PHA A: Tạo phiếu REVERSAL (hoặc trả về Replay / 409)
    const phaseA = await this.initiateReversalPhaseA(
      adminUserId,
      originalTransactionId,
      idempotencyKey,
      reversalDescription,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const reversalTx = phaseA.initiatedTx!;

    // PHA B: Đảo biến động số dư, ghi bút toán đảo và đóng dấu cả 2 giao dịch trong 1 transaction
    try {
      const completedReversal = await this.executeWithDeadlockRetry(
        TransactionType.REVERSAL,
        async () => {
          const queryRunner = await this.startTransactionWithLockTimeout();
          try {
            // 1. Tải các bút toán của giao dịch gốc để biết chính xác từng tài khoản cần đảo
            const originalEntries = await queryRunner.manager.find(
              LedgerEntry,
              {
                where: { transaction_id: originalTransactionId },
                order: { id: 'ASC' },
              },
            );

            if (originalEntries.length === 0) {
              throw new BusinessTransactionError(
                TransactionFailureCode.INTERNAL_ERROR,
              );
            }

            // 2. Khóa tất cả tài khoản liên quan theo thứ tự account.id ASC (chống Deadlock)
            // Lưu ý: Không kiểm tra trạng thái LOCKED của chủ tài khoản vì đây là thao tác hoàn tiền của Admin
            const accountIdsToLock = Array.from(
              new Set(originalEntries.map((e) => e.account_id)),
            );

            const lockedAccounts = await queryRunner.manager
              .createQueryBuilder(Account, 'account')
              .setLock('pessimistic_write', undefined, ['account'])
              .where('account.id IN (:...ids)', { ids: accountIdsToLock })
              .orderBy('account.id', 'ASC')
              .getMany();

            const accountMap = new Map(lockedAccounts.map((a) => [a.id, a]));

            // 3. Kiểm tra trước số dư trên các tài khoản cần bị trừ tiền (tức các dòng gốc là CREDIT)
            for (const origEntry of originalEntries) {
              if (origEntry.type === LedgerEntryType.CREDIT) {
                const targetAcc = accountMap.get(origEntry.account_id);
                if (!targetAcc) {
                  throw new BusinessTransactionError(
                    TransactionFailureCode.INTERNAL_ERROR,
                  );
                }
                this.ensureSufficientLockedBalance(
                  targetAcc.balance,
                  origEntry.amount,
                  TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE,
                );
              }
            }

            // 4. Thực hiện trừ tiền (cho các dòng gốc là CREDIT) và cộng tiền (cho các dòng gốc là DEBIT)
            // theo đúng thứ tự đảo ngược bút toán
            const inverseEntriesToInsert: LedgerEntryInput[] = [];

            for (const origEntry of originalEntries) {
              if (origEntry.type === LedgerEntryType.CREDIT) {
                // Gốc là CREDIT -> Hoàn tiền là DEBIT (trừ lại tiền)
                const balanceAfter = await this.debitAccount(
                  queryRunner.manager,
                  origEntry.account_id,
                  origEntry.amount,
                  TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE,
                );
                inverseEntriesToInsert.push({
                  accountId: origEntry.account_id,
                  transactionId: reversalTx.id,
                  type: LedgerEntryType.DEBIT,
                  amount: origEntry.amount,
                  balanceAfter,
                });
              } else {
                // Gốc là DEBIT -> Hoàn tiền là CREDIT (cộng trả lại tiền)
                const balanceAfter = await this.creditAccount(
                  queryRunner.manager,
                  origEntry.account_id,
                  origEntry.amount,
                );
                inverseEntriesToInsert.push({
                  accountId: origEntry.account_id,
                  transactionId: reversalTx.id,
                  type: LedgerEntryType.CREDIT,
                  amount: origEntry.amount,
                  balanceAfter,
                });
              }
            }

            // 5. Ghi các bút toán đảo vào bảng ledger_entries
            await this.insertLedgerEntries(
              queryRunner.manager,
              inverseEntriesToInsert,
            );

            // 6. Đóng dấu phiếu hoàn tiền: PROCESSING -> COMPLETED
            await this.transition(
              queryRunner.manager,
              reversalTx.id,
              TransactionStatus.PROCESSING,
              TransactionStatus.COMPLETED,
            );

            // 7. Đóng dấu có điều kiện lên giao dịch gốc: COMPLETED -> REVERSED (Lớp bảo vệ thứ 3 chống hoàn tiền 2 lần)
            await this.transition(
              queryRunner.manager,
              originalTransactionId,
              TransactionStatus.COMPLETED,
              TransactionStatus.REVERSED,
            );

            await queryRunner.commitTransaction();

            reversalTx.status = TransactionStatus.COMPLETED;
            return reversalTx;
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
          completedReversal,
          completedReversal.from_account_id ? 'outgoing' : 'incoming',
          phaseA.destAccountNumber,
          null,
        ),
      };
    } catch (phaseBError: any) {
      // Nếu lỗi là ConflictException do giao dịch gốc không còn ở trạng thái COMPLETED -> ghi nhận FAILED rồi ném 409
      if (phaseBError instanceof ConflictException) {
        await this.recordFailedTransactionPhaseC(
          reversalTx.id,
          TransactionFailureCode.INTERNAL_ERROR,
        );
        throw phaseBError;
      }

      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(reversalTx.id, failureCode);
      this.throwFailureException(failureCode);
    }
  }

  // =========================================================================
  // CHI TIẾT PHA A, PHA C & XỬ LÝ REPLAY THEO TRẠNG THÁI
  // =========================================================================

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

      const existingTx = await this.findExistingByIdempotencyKey(
        queryRunner.manager,
        actorAccountId,
        idempotencyKey,
      );
      if (existingTx) {
        await queryRunner.rollbackTransaction();
        const replay = await this.resolveIdempotencyReplay(
          queryRunner.manager,
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

      const createdTx = queryRunner.manager.create(Transaction, {
        actor_account_id: actorAccount.id,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        original_transaction_id: null,
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

      if (actorAccountId && error?.code === PG_UNIQUE_VIOLATION) {
        const existingTx = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          actorAccountId,
          idempotencyKey,
        );
        if (existingTx) {
          const replay = await this.resolveIdempotencyReplay(
            queryRunner.manager,
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
   * PHA A dành riêng cho nghiệp vụ Hoàn tiền (REVERSAL):
   * Kiểm tra Idempotency-Key của Admin, kiểm tra tính hợp lệ của giao dịch gốc,
   * và xử lý cả trường hợp đụng Partial Unique Index `IDX_transactions_active_reversal_original`.
   */
  private async initiateReversalPhaseA(
    adminUserId: string,
    originalTransactionId: string,
    idempotencyKey: string,
    reversalDescription: string,
  ): Promise<PhaseAInitiationResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let adminAccountId: string | null = null;
    let expectedPayload: ExpectedIdempotencyPayload | null = null;

    try {
      const adminAccount = await queryRunner.manager.findOne(Account, {
        where: { user_id: adminUserId },
        relations: { user: true },
      });
      this.validateActorAccount(adminAccount);
      adminAccountId = adminAccount.id;

      // 1. Tải giao dịch gốc để lấy thông tin đối chiếu
      const originalTx = await queryRunner.manager.findOne(Transaction, {
        where: { id: originalTransactionId },
        relations: { fromAccount: true, toAccount: true },
      });

      // Nếu không tìm thấy giao dịch gốc, vẫn kiểm tra xem Idempotency-Key này đã dùng cho giao dịch khác chưa
      if (!originalTx) {
        const existingByKey = await this.findExistingByIdempotencyKey(
          queryRunner.manager,
          adminAccountId,
          idempotencyKey,
        );
        if (existingByKey) {
          throw new ConflictException(
            'Idempotency-Key đã được sử dụng với nội dung giao dịch khác',
          );
        }
        throw new NotFoundException(
          'Không tìm thấy giao dịch gốc cần hoàn tiền',
        );
      }

      // Đảo chiều tài khoản: from của gốc thành to của REVERSAL, to của gốc thành from của REVERSAL
      const reversalFromAccountId = originalTx.to_account_id;
      const reversalToAccountId = originalTx.from_account_id;
      const counterpartyAccountNumber =
        originalTx.fromAccount?.account_number ??
        originalTx.toAccount?.account_number ??
        null;

      expectedPayload = {
        type: TransactionType.REVERSAL,
        amount: originalTx.amount,
        description: reversalDescription,
        toAccountNumber: originalTx.fromAccount?.account_number ?? null,
        originalTransactionId: originalTx.id,
      };

      // 2. Kiểm tra Idempotency-Key của Admin trước khi kiểm tra trạng thái COMPLETED của gốc
      // (để nếu giao dịch đã hoàn tiền xong, gửi lại cùng key sẽ trả 200 Replay thay vì báo 409)
      const existingTx = await this.findExistingByIdempotencyKey(
        queryRunner.manager,
        adminAccountId,
        idempotencyKey,
      );
      if (existingTx) {
        await queryRunner.rollbackTransaction();
        const replay = await this.resolveIdempotencyReplay(
          queryRunner.manager,
          existingTx,
          adminAccountId,
          expectedPayload,
        );
        return {
          isReplay: true,
          statusCode: replay.statusCode,
          transactionResponse: replay.transaction,
          actorAccountId: adminAccountId,
          destAccountNumber: counterpartyAccountNumber,
        };
      }

      // 3. Lớp bảo vệ 1: Chỉ cho phép hoàn tiền giao dịch ở trạng thái COMPLETED và không phải là REVERSAL
      if (originalTx.type === TransactionType.REVERSAL) {
        throw new ConflictException(
          'Không thể thực hiện hoàn tiền cho một giao dịch hoàn tiền (REVERSAL)',
        );
      }
      if (originalTx.status !== TransactionStatus.COMPLETED) {
        throw new ConflictException(
          `Chỉ có thể hoàn tiền cho giao dịch ở trạng thái COMPLETED (trạng thái hiện tại: ${originalTx.status})`,
        );
      }

      // 4. Tạo bản ghi REVERSAL ở trạng thái INITIATED -> PROCESSING
      const createdReversal = queryRunner.manager.create(Transaction, {
        actor_account_id: adminAccountId,
        from_account_id: reversalFromAccountId,
        to_account_id: reversalToAccountId,
        original_transaction_id: originalTx.id,
        amount: originalTx.amount,
        type: TransactionType.REVERSAL,
        status: TransactionStatus.INITIATED,
        failure_code: null,
        description: reversalDescription,
        idempotency_key: idempotencyKey,
      });

      const savedReversal = await queryRunner.manager.save(createdReversal);

      await this.transition(
        queryRunner.manager,
        savedReversal.id,
        TransactionStatus.INITIATED,
        TransactionStatus.PROCESSING,
      );
      savedReversal.status = TransactionStatus.PROCESSING;

      await queryRunner.commitTransaction();

      return {
        isReplay: false,
        initiatedTx: savedReversal,
        actorAccountId: adminAccountId,
        destAccountNumber: counterpartyAccountNumber,
      };
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      if (adminAccountId && error?.code === PG_UNIQUE_VIOLATION) {
        // Trường hợp 1: Trùng (idempotency_key, actor_account_id) -> trả về Replay (hoặc 409 nếu khác payload)
        if (expectedPayload) {
          const existingTx = await this.findExistingByIdempotencyKey(
            queryRunner.manager,
            adminAccountId,
            idempotencyKey,
          );
          if (existingTx) {
            const replay = await this.resolveIdempotencyReplay(
              queryRunner.manager,
              existingTx,
              adminAccountId,
              expectedPayload,
            );
            return {
              isReplay: true,
              statusCode: replay.statusCode,
              transactionResponse: replay.transaction,
              actorAccountId: adminAccountId,
              destAccountNumber: expectedPayload.toAccountNumber,
            };
          }
        }

        // Trường hợp 2: Đụng Partial Unique Index IDX_transactions_active_reversal_original
        // (Có một request hoàn tiền khác với key khác cho cùng giao dịch gốc đã/đang chạy) -> 409 Conflict!
        throw new ConflictException(
          'Giao dịch này đã được hoàn tiền hoặc đang có yêu cầu hoàn tiền khác xử lý',
        );
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

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
      this.logger.error(
        `[PhaseCFailure] Không thể ghi nhận trạng thái FAILED cho giao dịch ${transactionId}: ${phaseCError?.message}`,
      );
    } finally {
      await queryRunner.release();
    }
  }

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

  private async resolveIdempotencyReplay(
    manager: EntityManager,
    existingTx: Transaction,
    actorAccountId: string,
    expected: ExpectedIdempotencyPayload,
  ): Promise<{ statusCode: number; transaction: any }> {
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

    let reversalTransactionId: string | null = null;
    if (existingTx.status === TransactionStatus.REVERSED) {
      const completedRev = await manager.findOne(Transaction, {
        where: {
          original_transaction_id: existingTx.id,
          type: TransactionType.REVERSAL,
          status: TransactionStatus.COMPLETED,
        },
        select: { id: true },
      });
      reversalTransactionId = completedRev?.id ?? null;
    }

    if (
      existingTx.status === TransactionStatus.COMPLETED ||
      existingTx.status === TransactionStatus.REVERSED
    ) {
      return {
        statusCode: HttpStatus.OK,
        transaction: this.mapTransactionItem(
          existingTx,
          actorAccountId,
          reversalTransactionId,
        ),
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

    return {
      statusCode: HttpStatus.ACCEPTED,
      transaction: this.mapTransactionItem(
        existingTx,
        actorAccountId,
        reversalTransactionId,
      ),
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

  private mapTransactionItem(
    tx: Transaction,
    currentAccountId: string,
    reversalTransactionId: string | null = null,
  ) {
    const isIncoming = tx.to_account_id === currentAccountId;
    const counterpartyAccountNumber = isIncoming
      ? (tx.fromAccount?.account_number ?? null)
      : (tx.toAccount?.account_number ?? null);

    return this.mapTransactionResponse(
      tx,
      isIncoming ? 'incoming' : 'outgoing',
      counterpartyAccountNumber,
      reversalTransactionId,
    );
  }

  private mapTransactionResponse(
    tx: Transaction,
    direction: 'incoming' | 'outgoing',
    counterpartyAccountNumber: string | null,
    reversalTransactionId: string | null = null,
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
      originalTransactionId: tx.original_transaction_id ?? null,
      reversalTransactionId,
    };
  }
}
