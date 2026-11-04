import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
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
   * được tải từ Database (afterLoad). Giải quyết triệt để lưu ý ở Phụ lục P.2:
   * ngay cả khi Service gán đè thuộc tính trên cùng instance `user` trước khi gọi `save(user)`,
   * Subscriber vẫn giữ được nguyên vẹn ảnh trước (`before_data`).
   */
  private readonly loadedSnapshots = new WeakMap<
    User,
    AllowedUserAuditSnapshot
  >();

  constructor(private readonly dataSource: DataSource) {
    // Đăng ký Subscriber vào DataSource của ứng dụng (kiểm tra tránh đăng ký trùng)
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

    // Ưu tiên lấy ảnh trước từ WeakMap đã chụp lúc afterLoad; dự phòng bằng event.databaseEntity
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

    // Nếu không có trường nào trong danh sách cho phép thay đổi thì không ghi audit
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

    // Cập nhật lại bản chụp mới nhất vào WeakMap cho các lần thao tác tiếp theo trên cùng instance
    this.loadedSnapshots.set(updatedEntity, { ...afterSnapshot });
  }
}
