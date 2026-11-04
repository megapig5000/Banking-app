import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { AuditService } from './audit.service';
import { UserAuditSubscriber } from './user-audit.subscriber';
import { AuditInterceptor } from './audit.interceptor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService, UserAuditSubscriber, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}
