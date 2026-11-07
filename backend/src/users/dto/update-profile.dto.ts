import {
  IsOptional,
  IsString,
  IsEmail,
  MinLength,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'Nguyen Van A Updated',
    description: 'Họ và tên mới (từ 2 đến 100 ký tự)',
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Họ và tên phải có ít nhất 2 ký tự' })
  @MaxLength(100, { message: 'Họ và tên không được vượt quá 100 ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  fullName?: string;

  @ApiPropertyOptional({
    example: 'newemail@bank.local',
    description:
      'Địa chỉ email mới (bắt buộc phải gửi kèm currentPassword khi thay đổi email)',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Địa chỉ email không hợp lệ' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email?: string;

  @ApiPropertyOptional({
    example: '0901234567',
    nullable: true,
    description:
      'Số điện thoại Việt Nam (^(\\+84|0)\\d{9}$), hoặc truyền null để xóa số điện thoại',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    return value;
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @Matches(/^(\+84|0)\d{9}$/, {
    message:
      'Số điện thoại không hợp lệ. Phải đúng định dạng số điện thoại Việt Nam (0xxxxxxxxx hoặc +84xxxxxxxxx).',
  })
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'Password@123',
    description:
      'Mật khẩu hiện tại (bắt buộc khi thay đổi địa chỉ email; nếu sai trả về 400 Bad Request)',
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;
}
