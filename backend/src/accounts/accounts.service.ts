import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../database/entities/account.entity';
import { User, UserRole } from '../database/entities/user.entity';
import {
  AccountLimitsSummary,
  calculateAccountLimits,
  formatCentsToDecimal,
  parseDecimalToCents,
} from '../common/utils/date.util';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  async getMyAccount(userId: string) {
    const account = await this.accountRepository.findOne({
      where: { user_id: userId },
      relations: { user: true },
    });

    if (!account) {
      throw new NotFoundException('Không tìm thấy tài khoản ngân hàng của bạn');
    }

    const limits = await calculateAccountLimits(
      this.accountRepository.manager,
      account.id,
      account.tier,
    );

    return this.mapAccountResponse(account, limits);
  }

  /**
   * Tra cứu tài khoản theo accountNumber (Bài 4.1 — RBAC & Ownership Check):
   * - CUSTOMER: chỉ được phép xem tài khoản của chính mình; nếu tra cứu số tài khoản khác -> 403 Forbidden.
   * - ADMIN   : được phép xem mọi tài khoản; nếu số tài khoản không tồn tại (hoặc đã xóa mềm) -> 404 Not Found.
   */
  async getAccountByNumber(
    accountNumber: string,
    requester: Pick<User, 'id' | 'role'>,
  ) {
    const normalizedNumber = accountNumber.trim();
    const account = await this.accountRepository.findOne({
      where: { account_number: normalizedNumber },
      relations: { user: true },
    });

    if (requester.role !== UserRole.ADMIN) {
      if (!account || account.user_id !== requester.id) {
        throw new ForbiddenException(
          'Bạn không có quyền xem thông tin tài khoản của người khác',
        );
      }
      const limits = await calculateAccountLimits(
        this.accountRepository.manager,
        account.id,
        account.tier,
      );
      return this.mapAccountResponse(account, limits);
    }

    if (!account) {
      throw new NotFoundException('Không tìm thấy tài khoản ngân hàng');
    }

    const limits = await calculateAccountLimits(
      this.accountRepository.manager,
      account.id,
      account.tier,
    );

    return this.mapAccountResponse(account, limits);
  }

  /**
   * Tính số dư khả dụng (balance - hold_amount) bằng số học BigInt (đơn vị xu)
   * để tránh sai số dấu chấm động IEEE 754.
   */
  computeAvailableBalance(balanceStr: string, holdAmountStr: string): string {
    const balanceCents = parseDecimalToCents(balanceStr);
    const holdCents = parseDecimalToCents(holdAmountStr);
    const availableCents = balanceCents - holdCents;
    return formatCentsToDecimal(availableCents);
  }

  private mapAccountResponse(account: Account, limits: AccountLimitsSummary) {
    const holdAmount = account.hold_amount ?? '0.00';
    const availableBalance = this.computeAvailableBalance(
      account.balance,
      holdAmount,
    );

    return {
      id: account.id,
      accountNumber: account.account_number,
      balance: account.balance,
      holdAmount,
      availableBalance,
      status: account.status,
      tier: account.tier,
      limits,
      currency: account.currency,
      ownerName: account.user.full_name,
      createdAt: account.created_at,
    };
  }
}
