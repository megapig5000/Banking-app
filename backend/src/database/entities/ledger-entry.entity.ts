import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { Account } from './account.entity';
import { Transaction } from './transaction.entity';

export enum LedgerEntryType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

@Entity('ledger_entries')
@Index(['account_id', 'id'])
@Unique(['transaction_id', 'account_id', 'type'])
@Check('CHK_ledger_entries_amount_positive', `"amount" > 0`)
@Check('CHK_ledger_entries_balance_non_negative', `"balance_after" >= 0`)
export class LedgerEntry {
  // Dùng bigint tự tăng (BIGSERIAL) để cố định thứ tự ghi sổ tăng dần tuyệt đối
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'account_id', type: 'uuid' })
  account_id: string;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transaction_id: string;

  @ManyToOne(() => Transaction, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Column({
    type: 'enum',
    enum: LedgerEntryType,
  })
  type: LedgerEntryType;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  balance_after: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
