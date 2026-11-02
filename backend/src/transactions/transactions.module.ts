import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { Transaction } from '../database/entities/transaction.entity';
import { Account } from '../database/entities/account.entity';
import { LedgerEntry } from '../database/entities/ledger-entry.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Account, LedgerEntry])],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
