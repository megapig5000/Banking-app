import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { Account } from './account.entity';

export enum TransactionType {
  TRANSFER = 'TRANSFER',
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
  REVERSAL = 'REVERSAL',
}

export enum TransactionStatus {
  INITIATED = 'INITIATED',
  PENDING_OTP = 'PENDING_OTP',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

@Entity('transactions')
@Index(['from_account_id', 'created_at'])
@Index(['to_account_id', 'created_at'])
@Index(
  'IDX_transactions_active_reversal_original',
  ['original_transaction_id'],
  {
    unique: true,
    where: `"type" = 'REVERSAL' AND "status" IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')`,
  },
)
@Index('IDX_transactions_processing_updated_at', ['updated_at'], {
  where: `"status" = 'PROCESSING'`,
})
@Check(
  'CHK_transactions_type_accounts',
  `("type" = 'TRANSFER' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL AND "from_account_id" <> "to_account_id" AND "original_transaction_id" IS NULL) OR ("type" = 'DEPOSIT' AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL AND "original_transaction_id" IS NULL) OR ("type" = 'WITHDRAW' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL AND "original_transaction_id" IS NULL) OR ("type" = 'REVERSAL' AND ("from_account_id" IS NOT NULL OR "to_account_id" IS NOT NULL) AND ("from_account_id" IS NULL OR "to_account_id" IS NULL OR "from_account_id" <> "to_account_id") AND "original_transaction_id" IS NOT NULL)`,
)
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'actor_account_id', type: 'uuid' })
  actor_account_id: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'actor_account_id' })
  actorAccount: Account;

  @Column({ name: 'from_account_id', type: 'uuid', nullable: true })
  from_account_id: string | null;

  @ManyToOne(() => Account, (account) => account.outgoingTransactions, {
    nullable: true,
  })
  @JoinColumn({ name: 'from_account_id' })
  fromAccount: Account | null;

  @Column({ name: 'to_account_id', type: 'uuid', nullable: true })
  to_account_id: string | null;

  @ManyToOne(() => Account, (account) => account.incomingTransactions, {
    nullable: true,
  })
  @JoinColumn({ name: 'to_account_id' })
  toAccount: Account | null;

  @Column({ name: 'original_transaction_id', type: 'uuid', nullable: true })
  original_transaction_id: string | null;

  @ManyToOne(() => Transaction, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'original_transaction_id' })
  originalTransaction: Transaction | null;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({
    type: 'enum',
    enum: TransactionType,
    default: TransactionType.TRANSFER,
  })
  type: TransactionType;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
    default: TransactionStatus.INITIATED,
  })
  status: TransactionStatus;

  @Column({ name: 'failure_code', type: 'varchar', length: 50, nullable: true })
  failure_code: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
