import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import {
  getRequestContextSnapshot,
  MAX_IP_ADDRESS_LENGTH,
  MAX_USER_AGENT_LENGTH,
} from '../common/context/request-context';
import {
  getVietnamDayStart,
  getVietnamNextDayStart,
} from '../common/utils/date.util';
import { SortOrder } from '../transactions/dto/transaction-query.dto';
import { AuditAction } from './audit.constants';

export interface CreateAuditLogInput {
  actorId?: string | null;
  action: AuditAction | string;
  entity: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  beforeData?: Record<string, any> | null;
  afterData?: Record<string, any> | null;
}

export interface AuditLogsFilterParams {
  page?: number;
  limit?: number;
  actorId?: string;
  action?: AuditAction;
  entity?: string;
  entityId?: string;
  fromDate?: string;
  toDate?: string;
  order?: SortOrder;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * Ghi 1 dòng nhật ký kiểm toán vào bảng audit_logs (chỉ-ghi-thêm: INSERT).
   * - Khi truyền `manager` (từ Subscriber): ghi trong CÙNG database transaction với thay đổi dữ liệu.
   * - Khi không truyền `manager` (từ Interceptor): ghi best-effort ngay sau khi handler xử lý.
   */
  async recordAuditLog(
    input: CreateAuditLogInput,
    manager?: EntityManager,
  ): Promise<void> {
    const context = getRequestContextSnapshot();

    const actorId =
      input.actorId !== undefined ? input.actorId : context.actorId;
    const rawIp =
      input.ipAddress !== undefined ? input.ipAddress : context.ipAddress;
    const rawUa =
      input.userAgent !== undefined ? input.userAgent : context.userAgent;

    const ipAddress = rawIp ? rawIp.slice(0, MAX_IP_ADDRESS_LENGTH) : null;
    const userAgent = rawUa ? rawUa.slice(0, MAX_USER_AGENT_LENGTH) : null;

    const targetManager = manager ?? this.auditLogRepository.manager;

    await targetManager.insert(AuditLog, {
      actor_id: actorId ?? null,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      ip_address: ipAddress,
      user_agent: userAgent,
      before_data: input.beforeData ?? null,
      after_data: input.afterData ?? null,
    });
  }

  /**
   * Ghi nhật ký kiểm toán dạng best-effort (dùng trong AuditInterceptor):
   * Nếu có lỗi bất ngờ khi ghi log thì chỉ log error chứ không làm hỏng kết quả chính của request.
   */
  async recordAuditLogBestEffort(input: CreateAuditLogInput): Promise<void> {
    try {
      await this.recordAuditLog(input);
    } catch (err: any) {
      this.logger.error(
        `[AuditBestEffortError] Không thể ghi audit log (${input.action}): ${err?.message || err}`,
      );
    }
  }

  /**
   * Truy vấn danh sách audit_logs có phân trang và lọc tại Database (Chỉ dành cho ADMIN)
   */
  async getAuditLogs(query: AuditLogsFilterParams) {
    const {
      page = 1,
      limit = 10,
      actorId,
      action,
      entity,
      entityId,
      fromDate,
      toDate,
      order = SortOrder.DESC,
    } = query;

    if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
      throw new BadRequestException('fromDate không được lớn hơn toDate');
    }

    const qb = this.auditLogRepository
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.actor', 'actor');

    if (actorId) {
      qb.andWhere('audit.actor_id = :actorId', { actorId });
    }

    if (action) {
      qb.andWhere('audit.action = :action', { action });
    }

    if (entity) {
      qb.andWhere('audit.entity = :entity', { entity });
    }

    if (entityId) {
      qb.andWhere('audit.entity_id = :entityId', { entityId });
    }

    if (fromDate) {
      qb.andWhere('audit.created_at >= :fromDate', {
        fromDate: getVietnamDayStart(fromDate),
      });
    }

    if (toDate) {
      qb.andWhere('audit.created_at < :toDate', {
        toDate: getVietnamNextDayStart(toDate),
      });
    }

    const sortDirection = order.toUpperCase() as 'ASC' | 'DESC';
    // Sắp xếp theo id (bigint tự tăng) phản ánh chính xác thứ tự ghi nhật ký
    qb.orderBy('audit.id', sortDirection);

    qb.skip((page - 1) * limit).take(limit);

    const [logs, total] = await qb.getManyAndCount();

    const data = logs.map((log) => ({
      id: log.id,
      actor: log.actor
        ? {
            id: log.actor.id,
            fullName: log.actor.full_name,
            email: log.actor.email,
          }
        : null,
      action: log.action,
      entity: log.entity,
      entityId: log.entity_id,
      ipAddress: log.ip_address,
      userAgent: log.user_agent,
      beforeData: log.before_data,
      afterData: log.after_data,
      createdAt: log.created_at,
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
