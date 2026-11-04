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
import { Cron, CronExpression } from '@nestjs/schedule';
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
import {
  IdempotencyKey,
  IdempotencyKeyStatus,
} from '../database/entities/idempotency-key.entity';
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
  STUCK_AFTER_SECONDS,
  TransactionFailureCode,
} from './transactions.constants';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IdempotencyHashPayload } from '../idempotency/idempotency.constants';

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
  idempotencyRecordId?: string;
  actorAccountId: string;
  destAccountNumber: string | null;
}

export interface DeadlockStats {
  deadlockDetected: number;
  retrySucceeded: number;
  retryExhausted: number;
}

export interface SweepStuckResult {
  sweptCount: number;
  skippedWithLedgerCount: number;
  sweptIds: string[];
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
    private readonly idempotencyService: IdempotencyService,
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
  // JOB QUÉT GIAO DỊCH TREO (STUCK TRANSACTIONS SWEEP - BÀI 5.3 & MODULE 2)
  // =========================================================================

  /**
   * Cron job tự động chạy mỗi phút để phát hiện và đóng dấu FAILED (TIMEOUT) cho các giao dịch treo.
   * Trong môi trường test (NODE_ENV === 'test'), tắt lịch tự chạy để test chủ động gọi sweepStuckTransactions().
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleStuckTransactionsCron(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    await this.sweepStuckTransactions();
  }

  /**
   * Tìm các giao dịch PROCESSING có updated_at cũ hơn STUCK_AFTER_SECONDS (mặc định 120s):
   * - Nếu chưa có bút toán nào trong ledger_entries: trong CÙNG 1 transaction, chuyển giao dịch sang FAILED (TIMEOUT)
   *   và đóng luôn dòng khóa idempotency_keys tương ứng sang FAILED (503).
   * - Nếu đã có bút toán trong ledger_entries (bất thường trái thiết kế): log ERROR và giữ nguyên để xử lý thủ công.
   */
  async sweepStuckTransactions(
    stuckAfterSeconds: number = STUCK_AFTER_SECONDS,
  ): Promise<SweepStuckResult> {
    const candidates: Array<{
      id: string;
      type: TransactionType;
      ledger_count: string;
    }> = await this.dataSource.query(
      `
      SELECT t.id,
             t.type,
             COUNT(le.id)::text AS ledger_count
      FROM "transactions" t
      LEFT JOIN "ledger_entries" le ON le.transaction_id = t.id
      WHERE t.status = 'PROCESSING'
        AND t.updated_at < NOW() - ($1 * INTERVAL '1 second')
      GROUP BY t.id, t.type, t.updated_at
      ORDER BY t.updated_at ASC
      `,
      [stuckAfterSeconds],
    );

    let sweptCount = 0;
    let skippedWithLedgerCount = 0;
    const sweptIds: string[] = [];

    const timeoutDef = FAILURE_CODE_MAP[TransactionFailureCode.TIMEOUT];
    const timeoutResponseBody = this.buildFailureResponseBody(
      TransactionFailureCode.TIMEOUT,
    );

    for (const candidate of candidates) {
      const ledgerCount = parseInt(candidate.ledger_count, 10);

      if (ledgerCount > 0) {
        skippedWithLedgerCount += 1;
        this.logger.error(
          `[StuckSweepAnomaly] Phát hiện giao dịch PROCESSING (${candidate.id}, type=${candidate.type}) ` +
            `đã có ${ledgerCount} bút toán trong sổ cái! Không tự động đổi trạng thái để bảo toàn dữ liệu.`,
        );
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await this.transition(
            manager,
            candidate.id,
            TransactionStatus.PROCESSING,
            TransactionStatus.FAILED,
            { failureCode: TransactionFailureCode.TIMEOUT },
          );

          await this.idempotencyService.failStuckKeyByTransactionId(
            manager,
            candidate.id,
            timeoutDef.httpStatus,
            timeoutResponseBody,
          );
        });

        sweptCount += 1;
        sweptIds.push(candidate.id);
        this.logger.warn(
          `[StuckTransactionSwept] Đã đánh dấu FAILED (TIMEOUT) cho giao dịch treo và đóng khóa Idempotency: id=${candidate.id}, type=${candidate.type}`,
        );
      } catch {
        // Nếu ngay lúc quét mà giao dịch vừa được Pha B chuyển sang COMPLETED/FAILED thì bỏ qua an toàn
      }
    }

    if (sweptCount > 0 || skippedWithLedgerCount > 0) {
      this.logger.warn(
        `[StuckSweepSummary] Hoàn tất quét giao dịch treo: swept=${sweptCount}, anomalySkipped=${skippedWithLedgerCount}`,
      );
    }

    return { sweptCount, skippedWithLedgerCount, sweptIds };
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
    const hashPayload: IdempotencyHashPayload = {
      operation: 'TRANSFER',
      toAccountNumber: dto.toAccountNumber,
      amount: dto.amount,
      description: sanitizedDesc,
    };

    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      TransactionType.TRANSFER,
      dto.amount,
      sanitizedDesc,
      dto.toAccountNumber,
      hashPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;
    const idempotencyRecordId = phaseA.idempotencyRecordId!;

    try {
      const responseSnapshot = await this.executeWithDeadlockRetry(
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

            initiatedTx.status = TransactionStatus.COMPLETED;
            const snapshot = this.mapTransactionResponse(
              initiatedTx,
              'outgoing',
              phaseA.destAccountNumber,
              null,
            );

            // Chuyển dòng khóa sang COMPLETED kèm bản chụp kết quả trong CÙNG transaction với việc chuyển tiền
            await this.idempotencyService.completeInTransaction(
              queryRunner.manager,
              idempotencyRecordId,
              HttpStatus.CREATED,
              snapshot,
            );

            await queryRunner.commitTransaction();
            return snapshot;
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
        transaction: responseSnapshot,
      };
    } catch (phaseBError: any) {
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(
        initiatedTx.id,
        idempotencyRecordId,
        failureCode,
      );
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
    const hashPayload: IdempotencyHashPayload = {
      operation: 'DEPOSIT',
      amount: dto.amount,
      description: sanitizedDesc,
    };

    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      TransactionType.DEPOSIT,
      dto.amount,
      sanitizedDesc,
      null,
      hashPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;
    const idempotencyRecordId = phaseA.idempotencyRecordId!;

    try {
      const responseSnapshot = await this.executeWithDeadlockRetry(
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

            initiatedTx.status = TransactionStatus.COMPLETED;
            const snapshot = this.mapTransactionResponse(
              initiatedTx,
              'incoming',
              null,
              null,
            );

            await this.idempotencyService.completeInTransaction(
              queryRunner.manager,
              idempotencyRecordId,
              HttpStatus.CREATED,
              snapshot,
            );

            await queryRunner.commitTransaction();
            return snapshot;
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
        transaction: responseSnapshot,
      };
    } catch (phaseBError: any) {
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(
        initiatedTx.id,
        idempotencyRecordId,
        failureCode,
      );
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
    const hashPayload: IdempotencyHashPayload = {
      operation: 'WITHDRAW',
      amount: dto.amount,
      description: sanitizedDesc,
    };

    const phaseA = await this.initiateTransactionPhaseA(
      userId,
      idempotencyKey,
      TransactionType.WITHDRAW,
      dto.amount,
      sanitizedDesc,
      null,
      hashPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const initiatedTx = phaseA.initiatedTx!;
    const idempotencyRecordId = phaseA.idempotencyRecordId!;

    try {
      const responseSnapshot = await this.executeWithDeadlockRetry(
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

            initiatedTx.status = TransactionStatus.COMPLETED;
            const snapshot = this.mapTransactionResponse(
              initiatedTx,
              'outgoing',
              null,
              null,
            );

            await this.idempotencyService.completeInTransaction(
              queryRunner.manager,
              idempotencyRecordId,
              HttpStatus.CREATED,
              snapshot,
            );

            await queryRunner.commitTransaction();
            return snapshot;
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
        transaction: responseSnapshot,
      };
    } catch (phaseBError: any) {
      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(
        initiatedTx.id,
        idempotencyRecordId,
        failureCode,
      );
      this.throwFailureException(failureCode);
    }
  }

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

    const hashPayload: IdempotencyHashPayload = {
      operation: 'REVERSE',
      originalTransactionId,
      reason: sanitizedReason,
    };

    const phaseA = await this.initiateReversalPhaseA(
      adminUserId,
      originalTransactionId,
      idempotencyKey,
      reversalDescription,
      hashPayload,
    );
    if (phaseA.isReplay) {
      return {
        statusCode: phaseA.statusCode!,
        transaction: phaseA.transactionResponse,
      };
    }

    const reversalTx = phaseA.initiatedTx!;
    const idempotencyRecordId = phaseA.idempotencyRecordId!;

    try {
      const responseSnapshot = await this.executeWithDeadlockRetry(
        TransactionType.REVERSAL,
        async () => {
          const queryRunner = await this.startTransactionWithLockTimeout();
          try {
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

            const inverseEntriesToInsert: LedgerEntryInput[] = [];

            for (const origEntry of originalEntries) {
              if (origEntry.type === LedgerEntryType.CREDIT) {
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

            await this.insertLedgerEntries(
              queryRunner.manager,
              inverseEntriesToInsert,
            );

            await this.transition(
              queryRunner.manager,
              reversalTx.id,
              TransactionStatus.PROCESSING,
              TransactionStatus.COMPLETED,
            );

            await this.transition(
              queryRunner.manager,
              originalTransactionId,
              TransactionStatus.COMPLETED,
              TransactionStatus.REVERSED,
            );

            reversalTx.status = TransactionStatus.COMPLETED;
            const snapshot = this.mapTransactionResponse(
              reversalTx,
              reversalTx.from_account_id ? 'outgoing' : 'incoming',
              phaseA.destAccountNumber,
              null,
            );

            await this.idempotencyService.completeInTransaction(
              queryRunner.manager,
              idempotencyRecordId,
              HttpStatus.CREATED,
              snapshot,
            );

            await queryRunner.commitTransaction();
            return snapshot;
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
        transaction: responseSnapshot,
      };
    } catch (phaseBError: any) {
      if (phaseBError instanceof ConflictException) {
        await this.recordFailedTransactionPhaseC(
          reversalTx.id,
          idempotencyRecordId,
          TransactionFailureCode.INTERNAL_ERROR,
          {
            httpStatus: HttpStatus.CONFLICT,
            body: {
              statusCode: HttpStatus.CONFLICT,
              message: phaseBError.message,
              error: 'Conflict',
            },
          },
        );
        throw phaseBError;
      }

      const failureCode = this.classifyPhaseBFailure(phaseBError);
      await this.recordFailedTransactionPhaseC(
        reversalTx.id,
        idempotencyRecordId,
        failureCode,
      );
      this.throwFailureException(failureCode);
    }
  }

  // =========================================================================
  // CHI TIẾT PHA A, PHA C & XỬ LÝ REPLAY TỪ BẢNG IDEMPOTENCY_KEYS (MODULE 2)
  // =========================================================================

  private async initiateTransactionPhaseA(
    userId: string,
    idempotencyKey: string,
    txType: TransactionType,
    amount: string,
    description: string | null,
    toAccountNumber: string | null,
    hashPayload: IdempotencyHashPayload,
  ): Promise<PhaseAInitiationResult> {
    const requestHash = this.idempotencyService.computeRequestHash(hashPayload);
    const normalizedAmount =
      this.idempotencyService.normalizeDecimalAmount(amount);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const actorAccount = await queryRunner.manager.findOne(Account, {
        where: { user_id: userId },
        relations: { user: true },
      });
      this.validateActorAccount(actorAccount);
      const actorAccountId = actorAccount.id;

      // 1. Đăng ký hoặc kiểm tra khóa Idempotency bằng INSERT ... ON CONFLICT DO NOTHING
      const beginResult = await this.idempotencyService.beginIdempotency(
        queryRunner.manager,
        userId,
        idempotencyKey,
        requestHash,
      );

      if (!beginResult.isNew) {
        await queryRunner.rollbackTransaction();
        const replay = await this.resolveIdempotencyKeyReplay(
          queryRunner.manager,
          beginResult.record,
          actorAccountId,
        );
        return {
          isReplay: true,
          statusCode: replay.statusCode,
          transactionResponse: replay.transaction,
          actorAccountId,
          destAccountNumber: toAccountNumber,
        };
      }

      // 2. Nếu là khóa mới: kiểm tra tài khoản đích (404) và chặn tự chuyển (400).
      // Nếu ném lỗi ở đây, khối catch sẽ rollbackTransaction(), tự động hủy luôn dòng khóa IN_PROGRESS vừa tạo.
      let fromAccountId: string | null = null;
      let toAccountId: string | null = null;
      let destAccountNumber: string | null = null;

      if (txType === TransactionType.TRANSFER) {
        const destAccount = await queryRunner.manager.findOne(Account, {
          where: { account_number: toAccountNumber! },
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
      } else if (txType === TransactionType.DEPOSIT) {
        fromAccountId = null;
        toAccountId = actorAccount.id;
      } else if (txType === TransactionType.WITHDRAW) {
        fromAccountId = actorAccount.id;
        toAccountId = null;
      }

      // 3. Tạo phiếu giao dịch INITIATED -> PROCESSING và gắn transaction_id vào dòng khóa trong cùng transaction
      const createdTx = queryRunner.manager.create(Transaction, {
        actor_account_id: actorAccount.id,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        original_transaction_id: null,
        amount: normalizedAmount,
        type: txType,
        status: TransactionStatus.INITIATED,
        failure_code: null,
        description,
      });

      const savedTx = await queryRunner.manager.save(createdTx);

      await this.transition(
        queryRunner.manager,
        savedTx.id,
        TransactionStatus.INITIATED,
        TransactionStatus.PROCESSING,
      );
      savedTx.status = TransactionStatus.PROCESSING;

      await this.idempotencyService.attachTransactionId(
        queryRunner.manager,
        beginResult.record.id,
        savedTx.id,
      );

      await queryRunner.commitTransaction();

      return {
        isReplay: false,
        initiatedTx: savedTx,
        idempotencyRecordId: beginResult.record.id,
        actorAccountId,
        destAccountNumber,
      };
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async initiateReversalPhaseA(
    adminUserId: string,
    originalTransactionId: string,
    idempotencyKey: string,
    reversalDescription: string,
    hashPayload: IdempotencyHashPayload,
  ): Promise<PhaseAInitiationResult> {
    const requestHash = this.idempotencyService.computeRequestHash(hashPayload);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const adminAccount = await queryRunner.manager.findOne(Account, {
        where: { user_id: adminUserId },
        relations: { user: true },
      });
      this.validateActorAccount(adminAccount);
      const adminAccountId = adminAccount.id;

      // 1. Đăng ký hoặc kiểm tra khóa Idempotency của Admin bằng INSERT ... ON CONFLICT DO NOTHING
      const beginResult = await this.idempotencyService.beginIdempotency(
        queryRunner.manager,
        adminUserId,
        idempotencyKey,
        requestHash,
      );

      if (!beginResult.isNew) {
        await queryRunner.rollbackTransaction();
        const replay = await this.resolveIdempotencyKeyReplay(
          queryRunner.manager,
          beginResult.record,
          adminAccountId,
        );
        return {
          isReplay: true,
          statusCode: replay.statusCode,
          transactionResponse: replay.transaction,
          actorAccountId: adminAccountId,
          destAccountNumber: null,
        };
      }

      // 2. Kiểm tra giao dịch gốc (nếu lỗi 404/409 thì rollback sẽ hủy luôn dòng khóa IN_PROGRESS vừa chèn)
      const originalTx = await queryRunner.manager.findOne(Transaction, {
        where: { id: originalTransactionId },
        relations: { fromAccount: true, toAccount: true },
      });

      if (!originalTx) {
        throw new NotFoundException(
          'Không tìm thấy giao dịch gốc cần hoàn tiền',
        );
      }

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

      const reversalFromAccountId = originalTx.to_account_id;
      const reversalToAccountId = originalTx.from_account_id;
      const counterpartyAccountNumber =
        originalTx.fromAccount?.account_number ??
        originalTx.toAccount?.account_number ??
        null;

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
      });

      const savedReversal = await queryRunner.manager.save(createdReversal);

      await this.transition(
        queryRunner.manager,
        savedReversal.id,
        TransactionStatus.INITIATED,
        TransactionStatus.PROCESSING,
      );
      savedReversal.status = TransactionStatus.PROCESSING;

      await this.idempotencyService.attachTransactionId(
        queryRunner.manager,
        beginResult.record.id,
        savedReversal.id,
      );

      await queryRunner.commitTransaction();

      return {
        isReplay: false,
        initiatedTx: savedReversal,
        idempotencyRecordId: beginResult.record.id,
        actorAccountId: adminAccountId,
        destAccountNumber: counterpartyAccountNumber,
      };
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }

      // Nếu đụng Partial Unique Index IDX_transactions_active_reversal_original (23505)
      if (error?.code === PG_UNIQUE_VIOLATION) {
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
    idempotencyRecordId: string,
    failureCode: TransactionFailureCode,
    customErrorResponse?: { httpStatus: number; body: Record<string, any> },
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

      const def =
        FAILURE_CODE_MAP[failureCode] ??
        FAILURE_CODE_MAP[TransactionFailureCode.INTERNAL_ERROR];
      const responseStatus = customErrorResponse?.httpStatus ?? def.httpStatus;
      const responseBody =
        customErrorResponse?.body ?? this.buildFailureResponseBody(failureCode);

      await this.idempotencyService.failInTransaction(
        queryRunner.manager,
        idempotencyRecordId,
        responseStatus,
        responseBody,
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

  /**
   * Xử lý phát lại (Replay) từ dòng bản ghi idempotency_keys:
   * - COMPLETED: trả về 200 OK kèm đúng bản chụp response_body đã lưu lúc hoàn tất.
   * - FAILED   : ném lại đúng HttpException từ response_status và response_body đã lưu.
   * - IN_PROGRESS: trả về 202 Accepted kèm trạng thái hiện tại của giao dịch (dựng từ transaction_id).
   */
  private async resolveIdempotencyKeyReplay(
    manager: EntityManager,
    record: IdempotencyKey,
    actorAccountId: string,
  ): Promise<{ statusCode: number; transaction: any }> {
    if (record.status === IdempotencyKeyStatus.COMPLETED) {
      return {
        statusCode: HttpStatus.OK,
        transaction: record.response_body,
      };
    }

    if (record.status === IdempotencyKeyStatus.FAILED) {
      const savedStatus =
        record.response_status ?? HttpStatus.INTERNAL_SERVER_ERROR;
      const savedBody =
        record.response_body ??
        this.buildFailureResponseBody(TransactionFailureCode.INTERNAL_ERROR);
      throw new HttpException(savedBody, savedStatus);
    }

    // Trường hợp IN_PROGRESS: dựng phản hồi 202 Accepted từ giao dịch tương ứng
    if (record.transaction_id) {
      const existingTx = await manager.findOne(Transaction, {
        where: { id: record.transaction_id },
        relations: { fromAccount: true, toAccount: true },
      });

      if (existingTx) {
        return {
          statusCode: HttpStatus.ACCEPTED,
          transaction: this.mapTransactionItem(
            existingTx,
            actorAccountId,
            null,
          ),
        };
      }
    }

    return {
      statusCode: HttpStatus.ACCEPTED,
      transaction: {
        id: record.transaction_id,
        status: TransactionStatus.PROCESSING,
      },
    };
  }

  private buildFailureResponseBody(
    failureCode: TransactionFailureCode,
  ): Record<string, any> {
    const def =
      FAILURE_CODE_MAP[failureCode] ??
      FAILURE_CODE_MAP[TransactionFailureCode.INTERNAL_ERROR];

    let errorLabel = 'Internal Server Error';
    if (def.httpStatus === HttpStatus.UNPROCESSABLE_ENTITY) {
      errorLabel = 'Unprocessable Entity';
    } else if (def.httpStatus === HttpStatus.SERVICE_UNAVAILABLE) {
      errorLabel = 'Service Unavailable';
    }

    return {
      statusCode: def.httpStatus,
      message: def.message,
      error: errorLabel,
    };
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
        throw new HttpException(
          this.buildFailureResponseBody(failureCode),
          def.httpStatus,
        );
    }
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
