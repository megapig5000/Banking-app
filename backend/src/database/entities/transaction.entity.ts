import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { Account } from './account.entity';

export enum TransactionType {
  TRANSFER = 'transfer',
  DEPOSIT = 'deposit',
}

export enum TransactionStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  PENDING = 'pending',
}

@Entity('transactions')
@Index(['from_account_id', 'created_at'])
@Index(['to_account_id', 'created_at'])
@Unique(['idempotency_key', 'from_account_id'])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'from_account_id', nullable: true })
  from_account_id: string;

  @ManyToOne(() => Account, (account) => account.outgoingTransactions)
  @JoinColumn({ name: 'from_account_id' })
  fromAccount: Account;

  @Column({ name: 'to_account_id' })
  to_account_id: string;

  @ManyToOne(() => Account, (account) => account.incomingTransactions)
  @JoinColumn({ name: 'to_account_id' })
  toAccount: Account;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'enum', enum: TransactionType, default: TransactionType.TRANSFER })
  type: TransactionType;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.SUCCESS })
  status: TransactionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string;

  @Column({ type: 'uuid', nullable: true })
  idempotency_key: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}