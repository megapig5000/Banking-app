import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { User } from '../database/entities/user.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import {
  ALLOWED_USER_AUDIT_FIELDS,
  AllowedUserAuditSnapshot,
  AuditAction,
  AuditEntity,
  pickAllowedUserAuditSnapshot,
} from './audit.constants';
import {
  getRequestContextSnapshot,
  MAX_IP_ADDRESS_LENGTH,
  MAX_USER_AGENT_LENGTH,
} from '../common/context/request-context';

@Injectable()
@EventSubscriber()
export class UserAuditSubscriber implements EntitySubscriberInterface<User> {
  /**
   * WeakMap lưu bản chụp (snapshot) của các trường được phép ngay tại thời điểm thực thể User
   * được tải từ Database (afterLoad).
   */
  private readonly loadedSnapshots = new WeakMap<
    User,
    AllowedUserAuditSnapshot
  >();

  /**
   * WeakSet ngăn ghi đúp bản ghi USER_SOFT_DELETED nếu cả afterUpdate và afterSoftRemove
   * cùng được TypeORM kích hoạt trong một lệnh manager.softRemove(User, user).
   */
  private readonly softDeletedRecorded = new WeakSet<User>();

  constructor(private readonly dataSource: DataSource) {
    const alreadyRegistered = this.dataSource.subscribers.some(
      (sub) => sub instanceof UserAuditSubscriber,
    );
    if (!alreadyRegistered) {
      this.dataSource.subscribers.push(this);
    }
  }

  listenTo() {
    return User;
  }

  afterLoad(entity: User): void {
    const snapshot = pickAllowedUserAuditSnapshot(entity);
    if (snapshot) {
      this.loadedSnapshots.set(entity, { ...snapshot });
    }
  }

  async afterUpdate(event: UpdateEvent<User>): Promise<void> {
    const updatedEntity = event.entity as User | undefined;
    if (!updatedEntity) {
      return;
    }

    // Nếu đây là thao tác xóa mềm (cột deleted_at vừa được gán giá trị)
    if (updatedEntity.deleted_at) {
      await this.recordSoftDeleteAuditIfNeeded(
        event.manager,
        updatedEntity,
        event.databaseEntity,
      );
      return;
    }

    const beforeSnapshot =
      this.loadedSnapshots.get(updatedEntity) ??
      pickAllowedUserAuditSnapshot(event.databaseEntity);

    const afterSnapshot = pickAllowedUserAuditSnapshot(updatedEntity);

    if (!beforeSnapshot || !afterSnapshot) {
      return;
    }

    const beforeDiff: Record<string, any> = {};
    const afterDiff: Record<string, any> = {};
    const changedFields: string[] = [];

    for (const field of ALLOWED_USER_AUDIT_FIELDS) {
      if (beforeSnapshot[field] !== afterSnapshot[field]) {
        beforeDiff[field] = beforeSnapshot[field];
        afterDiff[field] = afterSnapshot[field];
        changedFields.push(field);
      }
    }

    if (changedFields.length === 0) {
      return;
    }

    const action =
      changedFields.length === 1 && changedFields[0] === 'status'
        ? AuditAction.USER_STATUS_CHANGED
        : AuditAction.USER_UPDATED;

    const context = getRequestContextSnapshot();

    // Ghi bằng event.manager để nằm trong CÙNG Database Transaction với thao tác sửa User
    await event.manager.insert(AuditLog, {
      actor_id: context.actorId,
      action,
      entity: AuditEntity.USERS,
      entity_id: updatedEntity.id ?? event.databaseEntity?.id ?? null,
      ip_address: context.ipAddress
        ? context.ipAddress.slice(0, MAX_IP_ADDRESS_LENGTH)
        : null,
      user_agent: context.userAgent
        ? context.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
        : null,
      before_data: beforeDiff,
      after_data: afterDiff,
    });

    this.loadedSnapshots.set(updatedEntity, { ...afterSnapshot });
  }

  async afterSoftRemove(event: SoftRemoveEvent<User>): Promise<void> {
    const removedEntity = event.entity as User | undefined;
    if (!removedEntity) {
      return;
    }
    await this.recordSoftDeleteAuditIfNeeded(
      event.manager,
      removedEntity,
      event.databaseEntity,
    );
  }

  private async recordSoftDeleteAuditIfNeeded(
    manager: SoftRemoveEvent<User>['manager'],
    entity: User,
    databaseEntity?: User,
  ): Promise<void> {
    if (this.softDeletedRecorded.has(entity)) {
      return;
    }
    this.softDeletedRecorded.add(entity);

    const beforeSnapshot =
      this.loadedSnapshots.get(entity) ??
      pickAllowedUserAuditSnapshot(databaseEntity) ??
      pickAllowedUserAuditSnapshot(entity);

    const context = getRequestContextSnapshot();

    await manager.insert(AuditLog, {
      actor_id: context.actorId,
      action: AuditAction.USER_SOFT_DELETED,
      entity: AuditEntity.USERS,
      entity_id: entity.id ?? databaseEntity?.id ?? null,
      ip_address: context.ipAddress
        ? context.ipAddress.slice(0, MAX_IP_ADDRESS_LENGTH)
        : null,
      user_agent: context.userAgent
        ? context.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
        : null,
      before_data: beforeSnapshot,
      after_data: {
        deletedAt: (entity.deleted_at ?? new Date()).toISOString(),
      } as Record<string, any>,
    });
  }
}
