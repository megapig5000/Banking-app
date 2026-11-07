import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
  Check,
} from 'typeorm';
import { User } from './user.entity';
import { Transaction } from './transaction.entity';

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  CLOSED = 'CLOSED',
}

export enum AccountTier {
  STANDARD = 'STANDARD',
  VIP = 'VIP',
}

@Entity('accounts')
@Index(['user_id'])
@Check('CHK_accounts_balance_non_negative', `"balance" >= 0`)
@Check('CHK_accounts_hold_non_negative', `"hold_amount" >= 0`)
@Check('CHK_accounts_hold_lte_balance', `"hold_amount" <= "balance"`)
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  user_id: string;

  @ManyToOne(() => User, (user) => user.accounts)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 20, unique: true })
  account_number: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  balance: string; // TypeORM maps numeric to string in TypeScript

  @Column({
    name: 'hold_amount',
    type: 'numeric',
    precision: 18,
    scale: 2,
    default: 0,
  })
  hold_amount: string;

  @Column({
    type: 'enum',
    enum: AccountStatus,
    default: AccountStatus.ACTIVE,
  })
  status: AccountStatus;

  @Column({
    type: 'enum',
    enum: AccountTier,
    default: AccountTier.STANDARD,
  })
  tier: AccountTier;

  @Column({ type: 'varchar', length: 10, default: 'VND' })
  currency: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deleted_at: Date | null;

  @OneToMany(() => Transaction, (transaction) => transaction.fromAccount)
  outgoingTransactions: Transaction[];

  @OneToMany(() => Transaction, (transaction) => transaction.toAccount)
  incomingTransactions: Transaction[];
}
