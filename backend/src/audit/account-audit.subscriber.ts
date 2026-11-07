import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  EventSubscriber,
  UpdateEvent,
} from 'typeorm';
import { Account } from '../database/entities/account.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import {
  ALLOWED_ACCOUNT_AUDIT_FIELDS,
  AllowedAccountAuditSnapshot,
  AuditAction,
  AuditEntity,
  pickAllowedAccountAuditSnapshot,
} from './audit.constants';
import {
  getRequestContextSnapshot,
  MAX_IP_ADDRESS_LENGTH,
  MAX_USER_AGENT_LENGTH,
} from '../common/context/request-context';

@Injectable()
@EventSubscriber()
export class AccountAuditSubscriber implements EntitySubscriberInterface<Account> {
  /**
   * WeakMap lưu bản chụp (snapshot) của các trường được phép (status, tier, holdAmount)
   * ngay tại thời điểm thực thể Account được tải từ Database (afterLoad).
   * Giải quyết triệt để lưu ý ở Phụ lục P.3 khi cập nhật Account bằng save() dưới khóa dòng.
   */
  private readonly loadedSnapshots = new WeakMap<
    Account,
    AllowedAccountAuditSnapshot
  >();

  constructor(private readonly dataSource: DataSource) {
    const alreadyRegistered = this.dataSource.subscribers.some(
      (sub) => sub instanceof AccountAuditSubscriber,
    );
    if (!alreadyRegistered) {
      this.dataSource.subscribers.push(this);
    }
  }

  listenTo() {
    return Account;
  }

  afterLoad(entity: Account): void {
    const snapshot = pickAllowedAccountAuditSnapshot(entity);
    if (snapshot) {
      this.loadedSnapshots.set(entity, { ...snapshot });
    }
  }

  async afterUpdate(event: UpdateEvent<Account>): Promise<void> {
    const updatedEntity = event.entity as Account | undefined;
    if (!updatedEntity) {
      return;
    }

    const beforeSnapshot =
      this.loadedSnapshots.get(updatedEntity) ??
      pickAllowedAccountAuditSnapshot(event.databaseEntity);

    const afterSnapshot = pickAllowedAccountAuditSnapshot(updatedEntity);

    if (!beforeSnapshot || !afterSnapshot) {
      return;
    }

    const beforeDiff: Record<string, any> = {};
    const afterDiff: Record<string, any> = {};
    const changedFields: string[] = [];

    for (const field of ALLOWED_ACCOUNT_AUDIT_FIELDS) {
      if (beforeSnapshot[field] !== afterSnapshot[field]) {
        beforeDiff[field] = beforeSnapshot[field];
        afterDiff[field] = afterSnapshot[field];
        changedFields.push(field);
      }
    }

    // Nếu không có trường nào trong danh sách ['status', 'tier', 'holdAmount'] thay đổi thì không ghi audit
    if (changedFields.length === 0) {
      return;
    }

    const context = getRequestContextSnapshot();

    // Ghi bằng event.manager để nằm trong CÙNG Database Transaction với thao tác sửa Account
    await event.manager.insert(AuditLog, {
      actor_id: context.actorId,
      action: AuditAction.ACCOUNT_UPDATED,
      entity: AuditEntity.ACCOUNTS,
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
}
