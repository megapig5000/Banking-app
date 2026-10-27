import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransferDto {
  @ApiProperty({ example: '1000000002', description: 'Số tài khoản đích' })
  @IsString()
  @IsNotEmpty()
  toAccountNumber: string;

  @ApiProperty({
    example: '50000.00',
    description: 'Số tiền cần chuyển (dạng string decimal)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, {
    message:
      'Số tiền không hợp lệ. Phải lớn hơn 0 và tối đa 2 chữ số thập phân.',
  })
  amount: string;

  @ApiPropertyOptional({
    example: 'Chuyen tien mua sach',
    description: 'Tối đa 200 ký tự',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;
}
