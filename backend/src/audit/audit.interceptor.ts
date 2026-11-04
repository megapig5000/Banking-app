import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError } from 'rxjs';
import { AuditService } from './audit.service';
import { AUDIT_METADATA_KEY, AuditDecoratorOptions } from './audit.decorator';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const options = this.reflector.get<AuditDecoratorOptions | undefined>(
      AUDIT_METADATA_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest();
    const res = httpCtx.getResponse();

    // Hỗ trợ bắt body trả về kể cả khi Controller dùng @Res() gọi trực tiếp res.json(body)
    let capturedJsonBody: any = undefined;
    if (res && typeof res.json === 'function') {
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        capturedJsonBody = body;
        return originalJson(body);
      };
    }

    return next.handle().pipe(
      tap((result) => {
        const effectiveResult =
          capturedJsonBody !== undefined ? capturedJsonBody : result;
        const httpStatus = res?.statusCode || HttpStatus.OK;
        const descriptor = options.onSuccess
          ? options.onSuccess(req, effectiveResult)
          : {};

        const afterData: Record<string, any> = {
          ...descriptor.afterData,
          outcome: 'SUCCESS',
          httpStatus,
        };

        void this.auditService.recordAuditLogBestEffort({
          actorId: descriptor.actorId,
          action: descriptor.action ?? options.action,
          entity: options.entity,
          entityId: descriptor.entityId ?? null,
          beforeData: descriptor.beforeData ?? null,
          afterData,
        });
      }),
      catchError((error: any) => {
        const httpStatus =
          error instanceof HttpException
            ? error.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        const descriptor = options.onError ? options.onError(req, error) : {};
        const actionToRecord =
          descriptor.action ?? options.failureAction ?? options.action;

        const afterData: Record<string, any> = {
          ...descriptor.afterData,
          outcome: 'ERROR',
          httpStatus,
        };

        // Ghi audit best-effort rồi NÉM LẠI ĐÚNG LỖI ĐÓ (tuyệt đối không nuốt lỗi)
        void this.auditService.recordAuditLogBestEffort({
          actorId: descriptor.actorId,
          action: actionToRecord,
          entity: options.entity,
          entityId: descriptor.entityId ?? null,
          beforeData: descriptor.beforeData ?? null,
          afterData,
        });

        throw error;
      }),
    );
  }
}
