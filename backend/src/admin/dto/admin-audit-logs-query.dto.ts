import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsUUID,
  IsString,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '../../audit/audit.constants';
import { SortOrder } from '../../transactions/dto/transaction-query.dto';

export class AdminAuditLogsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Trang hiện tại',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 10,
    description: 'Số bản ghi trên 1 trang (tối đa 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Lọc theo UUID của người thực hiện (actorId)',
  })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    enum: AuditAction,
    description: 'Lọc theo mã hành động kiểm toán',
  })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    example: 'users',
    description:
      'Lọc theo tên bảng/đối tượng bị tác động (users | transactions)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  entity?: string;

  @ApiPropertyOptional({
    description: 'Lọc theo ID của đối tượng bị tác động (entityId)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  entityId?: string;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Từ ngày (YYYY-MM-DD, theo múi giờ Việt Nam UTC+7)',
  })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Đến ngày (YYYY-MM-DD, theo múi giờ Việt Nam UTC+7)',
  })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.DESC,
    description: 'Chiều sắp xếp theo thứ tự ghi nhật ký id (asc | desc)',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder = SortOrder.DESC;
}
