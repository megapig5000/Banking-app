import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../database/entities/account.entity';

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
