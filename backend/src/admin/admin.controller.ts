import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { AdminAuditLogsQueryDto } from './dto/admin-audit-logs-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../database/entities/user.entity';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  @ApiOperation({
    summary:
      'Lấy danh sách người dùng kèm số tài khoản (Chỉ ADMIN, có phân trang & lọc theo status/role)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Trả về danh sách người dùng (không bao gồm passwordHash) và thông tin phân trang',
  })
  @ApiResponse({
    status: 400,
    description: 'Tham số lọc/phân trang không hợp lệ',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({
    status: 403,
    description: 'Không có quyền ADMIN hoặc tài khoản bị khóa',
  })
  async getUsers(@Query() query: AdminUsersQueryDto) {
    return this.adminService.getUsers(query);
  }

  @Patch('users/:id/status')
  @ApiOperation({
    summary:
      'Khóa hoặc mở khóa tài khoản người dùng (Chỉ ADMIN, có hiệu lực tức thì và tự động ghi Audit Log)',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID của người dùng cần đổi trạng thái',
  })
  @ApiResponse({
    status: 200,
    description: 'Cập nhật trạng thái người dùng thành công',
  })
  @ApiResponse({
    status: 400,
    description: 'Trạng thái không hợp lệ hoặc Admin tự khóa chính mình',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({ status: 403, description: 'Không có quyền ADMIN' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng' })
  async updateUserStatus(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(req.user.id, id, dto);
  }

  @Get('transactions')
  @ApiOperation({
    summary:
      'Xem toàn bộ giao dịch trên hệ thống (Chỉ ADMIN, lọc theo status, type, accountNumber, fromDate, toDate)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Trả về danh sách giao dịch dưới góc nhìn Admin (fromAccountNumber, toAccountNumber) và phân trang',
  })
  @ApiResponse({
    status: 400,
    description: 'Tham số lọc không hợp lệ (VD: fromDate > toDate)',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({ status: 403, description: 'Không có quyền ADMIN' })
  async getTransactions(@Query() query: AdminTransactionsQueryDto) {
    return this.adminService.getTransactions(query);
  }

  @Get('audit-logs')
  @ApiOperation({
    summary:
      'Xem nhật ký kiểm toán hệ thống (Chỉ ADMIN, lọc theo actorId, action, entity, entityId, fromDate, toDate)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Trả về danh sách nhật ký kiểm toán kèm ảnh trước/sau (beforeData, afterData) và phân trang',
  })
  @ApiResponse({
    status: 400,
    description: 'Tham số lọc không hợp lệ',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({ status: 403, description: 'Không có quyền ADMIN' })
  async getAuditLogs(@Query() query: AdminAuditLogsQueryDto) {
    return this.adminService.getAuditLogs(query);
  }
}
