import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  BadRequestException,
  Res,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { CashTransactionDto } from './dto/cash-transaction.dto';
import { ReverseTransactionDto } from './dto/reverse-transaction.dto';
import { TransactionQueryDto } from './dto/transaction-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../database/entities/user.entity';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiHeader,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDEMPOTENCY_HEADER_DESC =
  'UUID v4 chống xử lý trùng lặp (phạm vi theo từng người dùng, hạn dùng 24 giờ, lưu bản chụp kết quả trả về)';

@ApiTags('Transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lấy lịch sử giao dịch (bao gồm mọi trạng thái, kèm originalTransactionId & reversalTransactionId)',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về danh sách giao dịch và thông tin phân trang',
  })
  async getTransactions(
    @Request() req: any,
    @Query() query: TransactionQueryDto,
  ) {
    return this.transactionsService.getTransactions(req.user.id, query);
  }

  @Post('transfer')
  @ApiOperation({
    summary: 'Thực hiện chuyển khoản nội bộ (hỗ trợ Idempotency Snapshot)',
    description:
      'Yêu cầu header Idempotency-Key (UUID, hạn dùng 24h). Nếu gửi lại cùng key và cùng nội dung (request_hash), API trả về đúng bản chụp kết quả (response_body snapshot) đã lưu ở lần xử lý đầu tiên.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: IDEMPOTENCY_HEADER_DESC,
    required: true,
  })
  @ApiResponse({
    status: 201,
    description:
      'Chuyển khoản thành công (giao dịch mới COMPLETED, đã lưu bản chụp kết quả)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Phát lại (Replay): trả về đúng bản chụp kết quả (response_body snapshot) đã lưu của Idempotency-Key',
  })
  @ApiResponse({
    status: 202,
    description:
      'Yêu cầu cùng Idempotency-Key đang được xử lý (IN_PROGRESS / PROCESSING)',
  })
  @ApiResponse({
    status: 400,
    description: 'Thiếu/sai định dạng header UUID, DTO sai, hoặc tự chuyển',
  })
  @ApiResponse({
    status: 409,
    description:
      'Trùng Idempotency-Key nhưng khác nội dung yêu cầu (request_hash khác)',
  })
  @ApiResponse({
    status: 422,
    description:
      'Không đủ số dư hoặc tài khoản đích bị khóa (ghi nhận FAILED kèm bản chụp lỗi)',
  })
  @ApiResponse({
    status: 503,
    description: 'Hệ thống đang bận hoặc giao dịch quá thời gian chờ khóa',
  })
  async transfer(
    @Request() req: any,
    @Body() transferDto: TransferDto,
    @Res() res: Response,
  ) {
    const idempotencyKey = this.extractIdempotencyKey(req);
    const result = await this.transactionsService.transfer(
      req.user.id,
      idempotencyKey,
      transferDto,
    );

    return res.status(result.statusCode).json(result.transaction);
  }

  @Post('deposit')
  @ApiOperation({
    summary:
      'Nạp tiền vào tài khoản của bản thân (hỗ trợ Idempotency Snapshot)',
    description:
      'Yêu cầu header Idempotency-Key (UUID, hạn dùng 24h). Nếu gửi lại cùng key và cùng nội dung (request_hash), API trả về đúng bản chụp kết quả đã lưu.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: IDEMPOTENCY_HEADER_DESC,
    required: true,
  })
  @ApiResponse({
    status: 201,
    description:
      'Nạp tiền thành công (giao dịch mới COMPLETED, đã lưu bản chụp kết quả)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Phát lại (Replay): trả về đúng bản chụp kết quả (response_body snapshot) đã lưu',
  })
  @ApiResponse({
    status: 202,
    description:
      'Yêu cầu cùng Idempotency-Key đang được xử lý (IN_PROGRESS / PROCESSING)',
  })
  @ApiResponse({
    status: 400,
    description: 'Thiếu/sai định dạng header UUID hoặc số tiền không hợp lệ',
  })
  @ApiResponse({
    status: 409,
    description:
      'Trùng Idempotency-Key nhưng khác nội dung yêu cầu (request_hash khác)',
  })
  @ApiResponse({
    status: 422,
    description: 'Số dư sau khi nạp vượt quá giới hạn numeric(18,2)',
  })
  @ApiResponse({
    status: 503,
    description: 'Hệ thống đang bận (quá thời gian chờ khóa tài khoản)',
  })
  async deposit(
    @Request() req: any,
    @Body() depositDto: CashTransactionDto,
    @Res() res: Response,
  ) {
    const idempotencyKey = this.extractIdempotencyKey(req);
    const result = await this.transactionsService.deposit(
      req.user.id,
      idempotencyKey,
      depositDto,
    );

    return res.status(result.statusCode).json(result.transaction);
  }

  @Post('withdraw')
  @ApiOperation({
    summary: 'Rút tiền từ tài khoản của bản thân (hỗ trợ Idempotency Snapshot)',
    description:
      'Yêu cầu header Idempotency-Key (UUID, hạn dùng 24h). Nếu gửi lại cùng key và cùng nội dung (request_hash), API trả về đúng bản chụp kết quả đã lưu.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: IDEMPOTENCY_HEADER_DESC,
    required: true,
  })
  @ApiResponse({
    status: 201,
    description:
      'Rút tiền thành công (giao dịch mới COMPLETED, đã lưu bản chụp kết quả)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Phát lại (Replay): trả về đúng bản chụp kết quả (response_body snapshot) đã lưu',
  })
  @ApiResponse({
    status: 202,
    description:
      'Yêu cầu cùng Idempotency-Key đang được xử lý (IN_PROGRESS / PROCESSING)',
  })
  @ApiResponse({
    status: 400,
    description: 'Thiếu/sai định dạng header UUID hoặc số tiền không hợp lệ',
  })
  @ApiResponse({
    status: 409,
    description:
      'Trùng Idempotency-Key nhưng khác nội dung yêu cầu (request_hash khác)',
  })
  @ApiResponse({
    status: 422,
    description: 'Không đủ số dư khả dụng (ghi nhận FAILED kèm bản chụp lỗi)',
  })
  @ApiResponse({
    status: 503,
    description: 'Hệ thống đang bận (quá thời gian chờ khóa tài khoản)',
  })
  async withdraw(
    @Request() req: any,
    @Body() withdrawDto: CashTransactionDto,
    @Res() res: Response,
  ) {
    const idempotencyKey = this.extractIdempotencyKey(req);
    const result = await this.transactionsService.withdraw(
      req.user.id,
      idempotencyKey,
      withdrawDto,
    );

    return res.status(result.statusCode).json(result.transaction);
  }

  @Post(':id/reverse')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Hoàn tiền một giao dịch COMPLETED bằng giao dịch REVERSAL mới (Chỉ Admin, hỗ trợ Idempotency Snapshot)',
    description:
      'Yêu cầu quyền Admin và header Idempotency-Key (UUID, hạn dùng 24h). Nếu gửi lại cùng key và cùng nội dung, trả về đúng bản chụp kết quả hoàn tiền đã lưu.',
  })
  @ApiParam({
    name: 'id',
    description: 'UUID của giao dịch gốc cần hoàn tiền',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: IDEMPOTENCY_HEADER_DESC,
    required: true,
  })
  @ApiResponse({
    status: 201,
    description:
      'Hoàn tiền thành công (tạo giao dịch REVERSAL COMPLETED, giao dịch gốc chuyển sang REVERSED)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Phát lại (Replay): trả về đúng bản chụp giao dịch hoàn tiền đã lưu',
  })
  @ApiResponse({
    status: 202,
    description: 'Yêu cầu hoàn tiền cùng Idempotency-Key đang được xử lý',
  })
  @ApiResponse({
    status: 403,
    description: 'Không có quyền Admin',
  })
  @ApiResponse({
    status: 404,
    description: 'Không tìm thấy giao dịch gốc',
  })
  @ApiResponse({
    status: 409,
    description:
      'Giao dịch gốc không ở trạng thái COMPLETED, là REVERSAL, đã được hoàn tiền, hoặc trùng Idempotency-Key khác nội dung',
  })
  @ApiResponse({
    status: 422,
    description:
      'Tài khoản nhận tiền không đủ số dư để thu hồi hoàn tiền (REVERSAL_INSUFFICIENT_BALANCE)',
  })
  async reverseTransaction(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() reverseDto: ReverseTransactionDto,
    @Res() res: Response,
  ) {
    const idempotencyKey = this.extractIdempotencyKey(req);
    const result = await this.transactionsService.reverseTransaction(
      req.user.id,
      id,
      idempotencyKey,
      reverseDto,
    );

    return res.status(result.statusCode).json(result.transaction);
  }

  private extractIdempotencyKey(req: any): string {
    const idempotencyKey = req.headers['idempotency-key'] as string;
    if (!idempotencyKey || !UUID_REGEX.test(idempotencyKey)) {
      throw new BadRequestException(
        'Header Idempotency-Key là bắt buộc và phải đúng định dạng UUID',
      );
    }
    return idempotencyKey;
  }
}
