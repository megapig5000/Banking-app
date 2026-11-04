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
import { User } from './user.entity';
import { Transaction } from './transaction.entity';

export enum IdempotencyKeyStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('idempotency_keys')
@Unique(['user_id', 'idempotency_key'])
@Index(['expired_at'])
@Check(
  'CHK_idempotency_keys_response_status',
  `"status" = 'IN_PROGRESS' OR "response_status" IS NOT NULL`,
)
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotency_key: string;

  @Column({ name: 'request_hash', type: 'char', length: 64 })
  request_hash: string;

  @Column({
    type: 'enum',
    enum: IdempotencyKeyStatus,
    default: IdempotencyKeyStatus.IN_PROGRESS,
  })
  status: IdempotencyKeyStatus;

  @Column({ name: 'response_status', type: 'integer', nullable: true })
  response_status: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  response_body: Record<string, any> | null;

  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transaction_id: string | null;

  @ManyToOne(() => Transaction, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ name: 'expired_at', type: 'timestamptz' })
  expired_at: Date;
}
