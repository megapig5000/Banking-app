import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CashTransactionDto {
  @ApiProperty({
    example: '100000.00',
    description: 'Số tiền giao dịch (dạng string decimal, lớn hơn 0)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, {
    message:
      'Số tiền không hợp lệ. Phải lớn hơn 0 và tối đa 2 chữ số thập phân.',
  })
  amount: string;

  @ApiPropertyOptional({
    example: 'Nap tien vao tai khoan',
    description: 'Nội dung giao dịch (tối đa 200 ký tự)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;
}
