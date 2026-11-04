import { Controller, Get, Param, UseGuards, Request } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';

@ApiTags('Accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Lấy thông tin tài khoản ngân hàng của bản thân' })
  @ApiResponse({
    status: 200,
    description: 'Trả về thông tin Account của mình',
  })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập hoặc token sai' })
  @ApiResponse({
    status: 403,
    description: 'Tài khoản người dùng đang bị khóa',
  })
  async getMyAccount(@Request() req: any) {
    return this.accountsService.getMyAccount(req.user.id);
  }

  @Get(':accountNumber')
  @ApiOperation({
    summary:
      'Xem thông tin tài khoản theo số tài khoản (CUSTOMER chỉ xem được của mình; ADMIN xem được mọi tài khoản)',
  })
  @ApiParam({
    name: 'accountNumber',
    example: '1000000001',
    description: 'Số tài khoản ngân hàng cần tra cứu',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về thông tin Account',
  })
  @ApiResponse({
    status: 401,
    description: 'Chưa đăng nhập hoặc token không hợp lệ',
  })
  @ApiResponse({
    status: 403,
    description:
      'CUSTOMER cố tình xem tài khoản của người khác, hoặc tài khoản người gọi đang bị khóa',
  })
  @ApiResponse({
    status: 404,
    description: 'Không tìm thấy số tài khoản (khi ADMIN tra cứu)',
  })
  async getAccountByNumber(
    @Param('accountNumber') accountNumber: string,
    @Request() req: any,
  ) {
    return this.accountsService.getAccountByNumber(accountNumber, req.user);
  }
}
