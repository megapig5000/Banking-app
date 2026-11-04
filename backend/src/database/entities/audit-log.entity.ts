import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';

@Entity('audit_logs')
@Index(['created_at'])
@Index(['actor_id', 'id'])
@Index(['entity', 'entity_id'])
export class AuditLog {
  // Dùng bigint tự tăng (BIGSERIAL) đồng bộ với migration để cố định thứ tự ghi nhật ký (Phụ lục P.1)
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actor_id: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_id' })
  actor: User | null;

  @Column({ type: 'varchar', length: 60 })
  action: string;

  @Column({ type: 'varchar', length: 60 })
  entity: string;

  @Column({ name: 'entity_id', type: 'varchar', length: 64, nullable: true })
  entity_id: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ip_address: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  user_agent: string | null;

  @Column({ name: 'before_data', type: 'jsonb', nullable: true })
  before_data: Record<string, any> | null;

  @Column({ name: 'after_data', type: 'jsonb', nullable: true })
  after_data: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
