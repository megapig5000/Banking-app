import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { AuditAction, AuditEntity } from './audit.constants';

export const AUDIT_METADATA_KEY = 'audit_metadata';

export interface AuditEventDescriptor {
  action?: AuditAction;
  actorId?: string | null;
  entityId?: string | null;
  beforeData?: Record<string, any> | null;
  afterData?: Record<string, any> | null;
}

export interface AuditDecoratorOptions {
  action: AuditAction;
  failureAction?: AuditAction;
  entity: AuditEntity | string;
  onSuccess?: (req: Request, result: any) => AuditEventDescriptor;
  onError?: (req: Request, error: any) => AuditEventDescriptor;
}

export const Audit = (options: AuditDecoratorOptions) =>
  SetMetadata(AUDIT_METADATA_KEY, options);
