import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

@Entity('account_history')
@Unique(['user_id', 'version'])
@Index(['user_id', 'version'])
export class AccountHistory {
  // Dùng bigint tự tăng (BIGSERIAL) đồng bộ với migration (Phụ lục P.2)
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'integer' })
  version: number;

  @Column({ name: 'full_name', type: 'varchar', length: 100 })
  full_name: string;

  @Column({ type: 'varchar' })
  email: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ name: 'changed_by_user_id', type: 'uuid', nullable: true })
  changed_by_user_id: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'changed_by_user_id' })
  changedByUser: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
