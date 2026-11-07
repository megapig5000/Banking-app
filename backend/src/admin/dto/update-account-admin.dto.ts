import { IsOptional, IsEnum, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  AccountStatus,
  AccountTier,
} from '../../database/entities/account.entity';

export class UpdateAccountAdminDto {
  @ApiPropertyOptional({
    enum: AccountStatus,
    example: AccountStatus.FROZEN,
    description:
      'Trạng thái tài khoản mới (ACTIVE <-> FROZEN tự do; CLOSED là trạng thái cuối và chỉ đóng được khi balance = 0, hold_amount = 0, không có giao dịch đang dở)',
  })
  @IsOptional()
  @IsEnum(AccountStatus, {
    message:
      'Trạng thái tài khoản không hợp lệ. Chỉ chấp nhận ACTIVE, FROZEN hoặc CLOSED.',
  })
  status?: AccountStatus;

  @ApiPropertyOptional({
    enum: AccountTier,
    example: AccountTier.VIP,
    description: 'Hạng tài khoản áp dụng hạn mức (STANDARD hoặc VIP)',
  })
  @IsOptional()
  @IsEnum(AccountTier, {
    message: 'Hạng tài khoản không hợp lệ. Chỉ chấp nhận STANDARD hoặc VIP.',
  })
  tier?: AccountTier;

  @ApiPropertyOptional({
    example: '400000.00',
    description:
      'Số tiền phong tỏa/giữ chỗ (dạng chuỗi decimal >= 0 và <= balance)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, {
    message:
      'Số tiền phong tỏa (holdAmount) không hợp lệ. Phải là số không âm và tối đa 2 chữ số thập phân.',
  })
  holdAmount?: string;
}
