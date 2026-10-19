import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';

@ApiTags('Accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Lấy thông tin tài khoản ngân hàng của bản thân' })
  @ApiResponse({ status: 200, description: 'Trả về thông tin Account' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyAccount(@Request() req: any) {
    return this.accountsService.getMyAccount(req.user.id);
  }
}