import { Controller, Get, Post, Body, Query, UseGuards, Request, BadRequestException, Res, HttpStatus } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { TransactionQueryDto } from './dto/transaction-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';

@ApiTags('Transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy lịch sử giao dịch (có phân trang và lọc)' })
  @ApiResponse({ status: 200, description: 'Trả về danh sách giao dịch và thông tin phân trang' })
  async getTransactions(@Request() req: any, @Query() query: TransactionQueryDto) {
    return this.transactionsService.getTransactions(req.user.id, query);
  }

  @Post('transfer')
  @ApiOperation({ summary: 'Thực hiện chuyển khoản nội bộ' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID để chống double-submit', required: true })
  @ApiResponse({ status: 201, description: 'Chuyển khoản thành công (giao dịch mới)' })
  @ApiResponse({ status: 200, description: 'Trả về giao dịch cũ nếu gửi lại cùng Idempotency Key' })
  @ApiResponse({ status: 400, description: 'Thiếu header, DTO sai, hoặc tự chuyển cho chính mình' })
  @ApiResponse({ status: 409, description: 'Trùng Idempotency Key nhưng khác payload' })
  @ApiResponse({ status: 422, description: 'Không đủ số dư hoặc tài khoản đích bị khóa' })
  async transfer(
    @Request() req: any,
    @Body() transferDto: TransferDto,
    @Res() res: Response,
  ) {
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new BadRequestException('Header Idempotency-Key là bắt buộc và phải đúng định dạng UUID');
    }

    const result = await this.transactionsService.transfer(req.user.id, idempotencyKey, transferDto);

    if (result.isReplay) {
      return res.status(HttpStatus.OK).json(result.transaction);
    }
    return res.status(HttpStatus.CREATED).json(result.transaction);
  }
}