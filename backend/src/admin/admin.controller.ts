import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
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
import { UpdateAccountAdminDto } from './dto/update-account-admin.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { AdminAuditLogsQueryDto } from './dto/admin-audit-logs-query.dto';
import { ProfileHistoryQueryDto } from '../users/dto/profile-history-query.dto';
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
      'Lấy danh sách người dùng kèm thông tin tài khoản (Chỉ ADMIN, có phân trang, lọc status/role & hỗ trợ includeDeleted)',
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

  @Get('users/:id/profile-history')
  @ApiOperation({
    summary:
      'Xem lịch sử các phiên bản hồ sơ cũ của một người dùng bất kỳ (Chỉ ADMIN, có phân trang, mới nhất trước)',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID của người dùng cần tra cứu lịch sử hồ sơ',
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
  @ApiResponse({ status: 403, description: 'Không có quyền ADMIN' })
  @ApiResponse({ status: 404, description: 'Không tìm thấy người dùng' })
  async getUserProfileHistory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ProfileHistoryQueryDto,
  ) {
    return this.adminService.getUserProfileHistory(id, query);
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

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Xóa mềm người dùng CUSTOMER và đóng tài khoản ngân hàng (Chỉ ADMIN, yêu cầu số dư = 0, hold = 0, không có giao dịch đang dở)',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID của người dùng cần xóa mềm',
  })
  @ApiResponse({
    status: 204,
    description:
      'Xóa mềm thành công (tài khoản chuyển sang CLOSED, đặt deleted_at cho cả account & user, ghi Audit USER_SOFT_DELETED, thu hồi phiên tức thì)',
  })
  @ApiResponse({
    status: 400,
    description: 'UUID không hợp lệ hoặc Admin tự xóa chính mình',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({
    status: 403,
    description: 'Không có quyền ADMIN hoặc cố tình xóa tài khoản ADMIN khác',
  })
  @ApiResponse({
    status: 404,
    description: 'Không tìm thấy người dùng hoặc người dùng đã bị xóa mềm',
  })
  @ApiResponse({
    status: 409,
    description:
      'Không thể xóa do tài khoản vẫn còn số dư > 0, còn tiền phong tỏa (holdAmount > 0), hoặc đang có giao dịch xử lý dở dang',
  })
  async softDeleteUser(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.adminService.softDeleteUser(req.user.id, id);
  }

  @Patch('accounts/:accountNumber')
  @ApiOperation({
    summary:
      'Quản lý trạng thái tài khoản (ACTIVE/FROZEN/CLOSED), hạng tài khoản (STANDARD/VIP) và số tiền giữ chỗ holdAmount (Chỉ ADMIN, tự động ghi Audit Log ACCOUNT_UPDATED)',
  })
  @ApiParam({
    name: 'accountNumber',
    example: '1000000001',
    description: 'Số tài khoản ngân hàng cần cập nhật',
  })
  @ApiResponse({
    status: 200,
    description: 'Cập nhật thông tin tài khoản thành công',
  })
  @ApiResponse({
    status: 400,
    description:
      'Dữ liệu đầu vào không hợp lệ hoặc không có trường nào được gửi',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({ status: 403, description: 'Không có quyền ADMIN' })
  @ApiResponse({
    status: 404,
    description: 'Không tìm thấy tài khoản ngân hàng',
  })
  @ApiResponse({
    status: 409,
    description:
      'Vi phạm quy tắc chuyển trạng thái (đổi trạng thái từ CLOSED, hoặc đóng tài khoản khi còn số dư / còn hold / còn giao dịch đang xử lý)',
  })
  @ApiResponse({
    status: 422,
    description:
      'Số tiền phong tỏa (holdAmount) vượt quá số dư hiện tại của tài khoản',
  })
  async updateAccount(
    @Param('accountNumber') accountNumber: string,
    @Body() dto: UpdateAccountAdminDto,
  ) {
    return this.adminService.updateAccount(accountNumber, dto);
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
