import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ReverseTransactionDto {
  @ApiPropertyOptional({
    example: 'Khach hang chuyen nham tai khoan',
    description: 'Lý do hoàn tiền (tùy chọn, tối đa 200 ký tự)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  reason?: string;
}
