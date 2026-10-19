import { Injectable, BadRequestException, NotFoundException, UnprocessableEntityException, InternalServerErrorException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { Account } from '../database/entities/account.entity';
import { Transaction, TransactionType, TransactionStatus } from '../database/entities/transaction.entity';
import { UserStatus } from '../database/entities/user.entity';
import { TransferDto } from './dto/transfer.dto';
import { TransactionQueryDto, TransactionDirection } from './dto/transaction-query.dto';
import { sanitizeHtml } from '../common/utils/sanitize.util';

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
    const { page = 1, limit = 10, direction, fromDate, toDate, order = 'desc' } = query;

    if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
      throw new BadRequestException('fromDate không được lớn hơn toDate');
    }

    const account = await this.accountRepository.findOne({ where: { user_id: userId } });
    if (!account) {
      throw new NotFoundException('Không tìm thấy tài khoản ngân hàng của bạn');
    }
    const accountId = account.id;

    const qb = this.transactionRepository.createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.fromAccount', 'fromAccount')
      .leftJoinAndSelect('transaction.toAccount', 'toAccount');

    if (direction === TransactionDirection.INCOMING) {
      qb.andWhere('transaction.to_account_id = :accountId', { accountId });
    } else if (direction === TransactionDirection.OUTGOING) {
      qb.andWhere('transaction.from_account_id = :accountId', { accountId });
    } else {
      qb.andWhere('(transaction.from_account_id = :accountId OR transaction.to_account_id = :accountId)', { accountId });
    }

    if (fromDate) {
      const fromDateObj = new Date(`${fromDate}T00:00:00+07:00`);
      qb.andWhere('transaction.created_at >= :fromDate', { fromDate: fromDateObj });
    }
    
    if (toDate) {
      const toDateObj = new Date(`${toDate}T00:00:00+07:00`);
      toDateObj.setDate(toDateObj.getDate() + 1);
      qb.andWhere('transaction.created_at < :toDate', { toDate: toDateObj });
    }

    const sortDirection = order.toUpperCase() as 'ASC' | 'DESC';
    qb.orderBy('transaction.created_at', sortDirection)
      .addOrderBy('transaction.id', sortDirection);

    qb.skip((page - 1) * limit).take(limit);

    const [transactions, total] = await qb.getManyAndCount();

    const data = transactions.map((tx) => {
      const isIncoming = tx.to_account_id === accountId;
      const counterpartyAccountNumber = isIncoming ? tx.fromAccount?.account_number : tx.toAccount?.account_number;

      return {
        id: tx.id,
        amount: tx.amount,
        type: tx.type,
        status: tx.status,
        description: tx.description,
        createdAt: tx.created_at,
        direction: isIncoming ? 'incoming' : 'outgoing',
        counterpartyAccountNumber: counterpartyAccountNumber || null,
      };
    });

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
    if (parseFloat(dto.amount) <= 0) {
      throw new BadRequestException('Số tiền chuyển phải lớn hơn 0');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let sourceAccountId: string | null = null;

    try {
      const sourceAccount = await queryRunner.manager.findOne(Account, {
        where: { user_id: userId },
      });
      if (!sourceAccount) throw new NotFoundException('Không tìm thấy tài khoản nguồn');
      sourceAccountId = sourceAccount.id;

      const destAccount = await queryRunner.manager.findOne(Account, {
        where: { account_number: dto.toAccountNumber },
        relations: { user: true },
      });
      if (!destAccount) throw new NotFoundException('Tài khoản đích không tồn tại');
      if (destAccount.user.status !== UserStatus.ACTIVE) {
        throw new UnprocessableEntityException('Tài khoản đích đang bị khóa, không thể nhận tiền');
      }
      if (sourceAccount.id === destAccount.id) {
        throw new BadRequestException('Không thể tự chuyển tiền cho chính mình');
      }

      const debitResult = await queryRunner.manager.createQueryBuilder()
        .update(Account)
        .set({ balance: () => 'balance - :amount' })
        .where('id = :id AND balance >= :amount', { id: sourceAccount.id, amount: dto.amount })
        .execute();

      if (debitResult.affected === 0) {
        throw new UnprocessableEntityException('Không đủ số dư khả dụng');
      }

      await queryRunner.manager.createQueryBuilder()
        .update(Account)
        .set({ balance: () => 'balance + :amount' })
        .where('id = :id', { id: destAccount.id, amount: dto.amount })
        .execute();

      const sanitizedDesc = sanitizeHtml(dto.description || '');
      const tx = queryRunner.manager.create(Transaction, {
        from_account_id: sourceAccount.id,
        to_account_id: destAccount.id,
        amount: dto.amount,
        type: TransactionType.TRANSFER,
        status: TransactionStatus.SUCCESS,
        description: sanitizedDesc,
        idempotency_key: idempotencyKey,
      });

      const savedTx = await queryRunner.manager.save(tx);
      await queryRunner.commitTransaction();

      return { isReplay: false, transaction: this.mapTransferResponse(savedTx, dto.toAccountNumber) };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();

      if (error.code === '23505' && sourceAccountId) {
        const existingTx = await this.transactionRepository.findOne({
          where: { idempotency_key: idempotencyKey, from_account_id: sourceAccountId },
          relations: { toAccount: true },
        });

        if (existingTx) {
          const isSameDest = existingTx.toAccount.account_number === dto.toAccountNumber;
          const isSameAmount = parseFloat(existingTx.amount) === parseFloat(dto.amount);
          const expectedDesc = sanitizeHtml(dto.description || '') || null;
          const isSameDesc = (existingTx.description || null) === expectedDesc;

          if (isSameDest && isSameAmount && isSameDesc) {
            return { isReplay: true, transaction: this.mapTransferResponse(existingTx, dto.toAccountNumber) };
          }
          throw new ConflictException('Idempotency-Key đã được sử dụng với nội dung giao dịch khác');
        }
      }

      if (error.status) throw error;
      console.error('Transfer Error:', error);
      throw new InternalServerErrorException('Lỗi hệ thống khi thực hiện chuyển khoản');
    } finally {
      await queryRunner.release();
    }
  }

  private mapTransferResponse(tx: Transaction, toAccountNumber: string) {
    return {
      id: tx.id,
      amount: tx.amount,
      type: tx.type,
      status: tx.status,
      description: tx.description,
      createdAt: tx.created_at,
      direction: 'outgoing',
      counterpartyAccountNumber: toAccountNumber,
    };
  }
}