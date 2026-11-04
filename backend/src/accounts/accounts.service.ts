import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../database/entities/account.entity';
import { User, UserRole } from '../database/entities/user.entity';

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

    return this.mapAccountResponse(account);
  }

  /**
   * Tra cứu tài khoản theo accountNumber (Bài 4.1 — RBAC & Ownership Check):
   * - CUSTOMER: chỉ được phép xem tài khoản của chính mình; nếu tra cứu số tài khoản khác -> 403 Forbidden.
   * - ADMIN   : được phép xem mọi tài khoản; nếu số tài khoản không tồn tại -> 404 Not Found.
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
      return this.mapAccountResponse(account);
    }

    if (!account) {
      throw new NotFoundException('Không tìm thấy tài khoản ngân hàng');
    }

    return this.mapAccountResponse(account);
  }

  private mapAccountResponse(account: Account) {
    return {
      id: account.id,
      accountNumber: account.account_number,
      balance: account.balance,
      currency: account.currency,
      ownerName: account.user.full_name,
      createdAt: account.created_at,
    };
  }
}
