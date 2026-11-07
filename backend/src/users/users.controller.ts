import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileHistoryQueryDto } from './dto/profile-history-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Lấy thông tin hồ sơ cá nhân của bản thân (bao gồm phone và profileVersion)',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về thông tin hồ sơ hiện tại của người dùng',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  async getMyProfile(@Request() req: any) {
    return this.usersService.getMyProfile(req.user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary:
      'Cập nhật hồ sơ cá nhân của chính mình (lưu phiên bản cũ vào account_history và ghi Audit USER_UPDATED trong cùng transaction)',
    description:
      'Cho phép sửa fullName, email, phone. Nếu thay đổi email thì bắt buộc phải gửi kèm currentPassword (sai mật khẩu hiện tại trả về 400 Bad Request, trùng email trả về 409 Conflict).',
  })
  @ApiResponse({
    status: 200,
    description:
      'Cập nhật hồ sơ thành công (nếu có thay đổi thực sự thì chèn bản cũ vào account_history và tăng profileVersion + 1)',
  })
  @ApiResponse({
    status: 400,
    description:
      'Dữ liệu không hợp lệ, số điện thoại sai định dạng VN, hoặc thiếu/sai currentPassword khi đổi email',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({
    status: 409,
    description: 'Địa chỉ email mới đã tồn tại trong hệ thống',
  })
  async updateMyProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateMyProfile(req.user.id, dto);
  }

  @Get('me/profile-history')
  @ApiOperation({
    summary:
      'Xem lịch sử các phiên bản hồ sơ cũ của bản thân (có phân trang, mặc định mới nhất trước)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Trả về danh sách các phiên bản hồ sơ cũ (version, fullName, email, phone, changedByUserId, changedAt) và meta phân trang',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  async getMyProfileHistory(
    @Request() req: any,
    @Query() query: ProfileHistoryQueryDto,
  ) {
    return this.usersService.getProfileHistory(req.user.id, query, false);
  }
}
