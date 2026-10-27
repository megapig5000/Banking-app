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

export enum TransactionType {
  TRANSFER = 'transfer',
  DEPOSIT = 'deposit',
  WITHDRAW = 'withdraw',
}

export enum TransactionStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  PENDING = 'pending',
}

@Entity('transactions')
@Index(['from_account_id', 'created_at'])
@Index(['to_account_id', 'created_at'])
@Unique(['idempotency_key', 'actor_account_id'])
@Check(
  'CHK_transactions_type_accounts',
  `("type" = 'transfer' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL AND "from_account_id" <> "to_account_id") OR ("type" = 'deposit' AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL) OR ("type" = 'withdraw' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL)`,
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
    default: TransactionStatus.SUCCESS,
  })
  status: TransactionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'uuid', nullable: true })
  idempotency_key: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
