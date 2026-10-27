import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum TransactionDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class TransactionQueryDto {
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
    description: 'Số bản ghi trên 1 trang',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    enum: TransactionDirection,
    description: 'Chiều giao dịch',
  })
  @IsOptional()
  @IsEnum(TransactionDirection)
  direction?: TransactionDirection;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Từ ngày (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Đến ngày (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.DESC,
    description: 'Chiều sắp xếp theo thời gian',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order?: SortOrder = SortOrder.DESC;
}
