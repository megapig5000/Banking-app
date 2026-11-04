import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsDateString,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  TransactionStatus,
  TransactionType,
} from '../../database/entities/transaction.entity';
import { SortOrder } from '../../transactions/dto/transaction-query.dto';

export class AdminTransactionsQueryDto {
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
    enum: TransactionStatus,
    description: 'Lọc theo trạng thái giao dịch',
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiPropertyOptional({
    enum: TransactionType,
    description:
      'Lọc theo loại giao dịch (TRANSFER, DEPOSIT, WITHDRAW, REVERSAL)',
  })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({
    example: '1000000001',
    description:
      'Lọc theo số tài khoản (khớp tài khoản nguồn hoặc tài khoản đích)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  accountNumber?: string;

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
    description: 'Chiều sắp xếp theo thời gian (asc | desc)',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder = SortOrder.DESC;
}
