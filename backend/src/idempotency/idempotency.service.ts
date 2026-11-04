import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  IdempotencyKey,
  IdempotencyKeyStatus,
} from '../database/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_TTL_HOURS,
  IdempotencyHashPayload,
} from './idempotency.constants';

export interface BeginIdempotencyResult {
  isNew: boolean;
  record: IdempotencyKey;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Cron job tự động chạy mỗi giờ để dọn dẹp các khóa Idempotency đã hết hạn (expired_at < NOW())
   * và không còn ở trạng thái IN_PROGRESS.
   * Trong môi trường test (NODE_ENV === 'test'), tắt lịch tự chạy để test gọi trực tiếp deleteExpiredKeys().
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleExpiredKeysCleanupCron(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    await this.deleteExpiredKeys();
  }

  /**
   * Chuẩn hóa chuỗi số tiền về đúng định dạng 2 chữ số thập phân bằng xử lý chuỗi thuần túy
   * (Ví dụ: "10" -> "10.00", "10.5" -> "10.50", "0010.25" -> "10.25")
   * Tuyệt đối không dùng Number/parseFloat để tránh sai số IEEE 754.
   */
  normalizeDecimalAmount(amountStr: string): string {
    const trimmed = amountStr.trim();
    const isNegative = trimmed.startsWith('-');
    const unsigned = isNegative ? trimmed.slice(1) : trimmed;
    const [rawInt = '0', rawFrac = ''] = unsigned.split('.');
    const normalizedInt = rawInt.replace(/^0+(?=\d)/, '') || '0';
    const normalizedFrac = (rawFrac + '00').slice(0, 2);
    return `${isNegative ? '-' : ''}${normalizedInt}.${normalizedFrac}`;
  }

  /**
   * Tính mã băm SHA-256 (64 ký tự hex) từ dữ liệu yêu cầu đã chuẩn hóa theo thứ tự trường cố định.
   */
  computeRequestHash(payload: IdempotencyHashPayload): string {
    let canonicalObject: Record<string, string>;

    switch (payload.operation) {
      case 'TRANSFER':
        canonicalObject = {
          operation: 'TRANSFER',
          toAccountNumber: payload.toAccountNumber.trim(),
          amount: this.normalizeDecimalAmount(payload.amount),
          description: payload.description ?? '',
        };
        break;
      case 'DEPOSIT':
        canonicalObject = {
          operation: 'DEPOSIT',
          amount: this.normalizeDecimalAmount(payload.amount),
          description: payload.description ?? '',
        };
        break;
      case 'WITHDRAW':
        canonicalObject = {
          operation: 'WITHDRAW',
          amount: this.normalizeDecimalAmount(payload.amount),
          description: payload.description ?? '',
        };
        break;
      case 'REVERSE':
        canonicalObject = {
          operation: 'REVERSE',
          originalTransactionId: payload.originalTransactionId.trim(),
          reason: payload.reason ?? '',
        };
        break;
    }

    const serialized = JSON.stringify(canonicalObject);
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  /**
   * Bước đầu Pha A:
   * 1. Xóa khóa cũ đã hết hạn (expired_at <= NOW() và status <> 'IN_PROGRESS') của đúng (userId, idempotencyKey).
   * 2. Thử chèn dòng khóa mới (status = 'IN_PROGRESS') bằng INSERT ... ON CONFLICT DO NOTHING RETURNING *.
   * 3. Nếu chèn được -> trả về { isNew: true, record }.
   * 4. Nếu không chèn được (khóa đã tồn tại):
   *    - Đọc dòng khóa hiện có của đúng (userId, idempotencyKey).
   *    - Kiểm tra request_hash: nếu khác -> ném 409 ConflictException ngay.
   *    - Nếu khớp request_hash -> trả về { isNew: false, record } để Pha A phát lại kết quả.
   */
  async beginIdempotency(
    manager: EntityManager,
    userId: string,
    idempotencyKey: string,
    requestHash: string,
    ttlHours: number = IDEMPOTENCY_TTL_HOURS,
  ): Promise<BeginIdempotencyResult> {
    // Xóa dòng khóa cũ của đúng (user_id, idempotency_key) nếu đã hết hạn và không còn IN_PROGRESS
    await manager.query(
      `
      DELETE FROM "idempotency_keys"
      WHERE "user_id" = $1
        AND "idempotency_key" = $2
        AND "expired_at" <= NOW()
        AND "status" <> 'IN_PROGRESS'
      `,
      [userId, idempotencyKey],
    );

    const insertedRows: IdempotencyKey[] = await manager.query(
      `
      INSERT INTO "idempotency_keys" (
        "user_id",
        "idempotency_key",
        "request_hash",
        "status",
        "expired_at"
      )
      VALUES (
        $1,
        $2,
        $3,
        'IN_PROGRESS',
        NOW() + ($4 * INTERVAL '1 hour')
      )
      ON CONFLICT ("user_id", "idempotency_key") DO NOTHING
      RETURNING *
      `,
      [userId, idempotencyKey, requestHash, ttlHours],
    );

    if (insertedRows.length > 0) {
      return {
        isNew: true,
        record: insertedRows[0],
      };
    }

    const existingRecord = await manager.findOne(IdempotencyKey, {
      where: {
        user_id: userId,
        idempotency_key: idempotencyKey,
      },
    });

    if (!existingRecord) {
      throw new ConflictException(
        'Không thể xác thực trạng thái Idempotency-Key, vui lòng thử lại',
      );
    }

    if (existingRecord.request_hash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key đã được sử dụng với nội dung giao dịch khác',
      );
    }

    return {
      isNew: false,
      record: existingRecord,
    };
  }

  /**
   * Gắn transaction_id vào dòng khóa IN_PROGRESS ngay trong Pha A sau khi đã tạo phiếu giao dịch.
   */
  async attachTransactionId(
    manager: EntityManager,
    idempotencyRecordId: string,
    transactionId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({ transaction_id: transactionId })
      .where('id = :id AND status = :status', {
        id: idempotencyRecordId,
        status: IdempotencyKeyStatus.IN_PROGRESS,
      })
      .execute();
  }

  /**
   * Đóng dấu dòng khóa IN_PROGRESS -> COMPLETED kèm bản chụp kết quả (response_status & response_body)
   * trong cùng transaction của Pha B với việc chuyển tiền.
   */
  async completeInTransaction(
    manager: EntityManager,
    idempotencyRecordId: string,
    responseStatus: number,
    responseBody: Record<string, any>,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: IdempotencyKeyStatus.COMPLETED,
        response_status: responseStatus,
        response_body: responseBody,
      })
      .where('id = :id AND status = :fromStatus', {
        id: idempotencyRecordId,
        fromStatus: IdempotencyKeyStatus.IN_PROGRESS,
      })
      .execute();

    if (result.affected === 0) {
      throw new ConflictException(
        'Trạng thái Idempotency-Key đã thay đổi, không thể hoàn tất giao dịch',
      );
    }
  }

  /**
   * Đóng dấu dòng khóa IN_PROGRESS -> FAILED kèm bản chụp lỗi (response_status & response_body)
   * trong cùng transaction của Pha C.
   */
  async failInTransaction(
    manager: EntityManager,
    idempotencyRecordId: string,
    responseStatus: number,
    responseBody: Record<string, any>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: IdempotencyKeyStatus.FAILED,
        response_status: responseStatus,
        response_body: responseBody,
      })
      .where('id = :id AND status = :fromStatus', {
        id: idempotencyRecordId,
        fromStatus: IdempotencyKeyStatus.IN_PROGRESS,
      })
      .execute();
  }

  /**
   * Đóng dấu dòng khóa tương ứng với giao dịch treo (theo transaction_id) từ IN_PROGRESS -> FAILED (503 TIMEOUT)
   * khi job sweepStuckTransactions() quét giao dịch treo.
   */
  async failStuckKeyByTransactionId(
    manager: EntityManager,
    transactionId: string,
    responseStatus: number,
    responseBody: Record<string, any>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({
        status: IdempotencyKeyStatus.FAILED,
        response_status: responseStatus,
        response_body: responseBody,
      })
      .where('transaction_id = :transactionId AND status = :fromStatus', {
        transactionId,
        fromStatus: IdempotencyKeyStatus.IN_PROGRESS,
      })
      .execute();
  }

  /**
   * Xóa các dòng khóa đã hết hạn (expired_at < NOW()) và không còn ở trạng thái IN_PROGRESS.
   */
  async deleteExpiredKeys(): Promise<number> {
    const deletedRows: Array<{ id: string }> = await this.dataSource.query(
      `
      DELETE FROM "idempotency_keys"
      WHERE "expired_at" < NOW()
        AND "status" <> 'IN_PROGRESS'
      RETURNING "id"
      `,
    );

    const deletedCount = deletedRows.length;
    if (deletedCount > 0) {
      this.logger.log(
        `[IdempotencyCleanup] Đã dọn dẹp ${deletedCount} khóa Idempotency hết hạn.`,
      );
    }
    return deletedCount;
  }
}
