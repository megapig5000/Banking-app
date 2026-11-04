import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../database/entities/user.entity';

export class UpdateUserStatusDto {
  @ApiProperty({
    enum: UserStatus,
    example: UserStatus.LOCKED,
    description: 'Trạng thái mới của người dùng (active hoặc locked)',
  })
  @IsNotEmpty()
  @IsEnum(UserStatus, {
    message: 'Trạng thái không hợp lệ. Chỉ chấp nhận active hoặc locked.',
  })
  status: UserStatus;
}
