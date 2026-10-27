import AppDataSource from './data-source';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { Account } from './entities/account.entity';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
} from './entities/transaction.entity';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

async function runSeed() {
  await AppDataSource.initialize();
  console.log('Database connected. Starting seed...');

  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const passwordHash = await bcrypt.hash('Password@123', 10);

    // 1. Tạo Customer A
    let user1 = await queryRunner.manager.findOne(User, {
      where: { email: 'user1@bank.local' },
    });
    if (!user1) {
      user1 = queryRunner.manager.create(User, {
        full_name: 'Customer A',
        email: 'user1@bank.local',
        password_hash: passwordHash,
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      user1 = await queryRunner.manager.save(user1);

      await queryRunner.manager.save(
        queryRunner.manager.create(Account, {
          user_id: user1.id,
          account_number: '1000000001',
          balance: '5000000.00',
          currency: 'VND',
        }),
      );
      console.log('Created User 1 (Customer A)');
    }

    // 2. Tạo Customer B
    let user2 = await queryRunner.manager.findOne(User, {
      where: { email: 'user2@bank.local' },
    });
    if (!user2) {
      user2 = queryRunner.manager.create(User, {
        full_name: 'Customer B',
        email: 'user2@bank.local',
        password_hash: passwordHash,
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      user2 = await queryRunner.manager.save(user2);

      await queryRunner.manager.save(
        queryRunner.manager.create(Account, {
          user_id: user2.id,
          account_number: '1000000002',
          balance: '2000000.00',
          currency: 'VND',
        }),
      );
      console.log('Created User 2 (Customer B)');
    }

    // 3. Tạo Locked Customer
    let user3 = await queryRunner.manager.findOne(User, {
      where: { email: 'user3@bank.local' },
    });
    if (!user3) {
      user3 = queryRunner.manager.create(User, {
        full_name: 'Locked Customer',
        email: 'user3@bank.local',
        password_hash: passwordHash,
        role: UserRole.CUSTOMER,
        status: UserStatus.LOCKED,
      });
      user3 = await queryRunner.manager.save(user3);

      await queryRunner.manager.save(
        queryRunner.manager.create(Account, {
          user_id: user3.id,
          account_number: '1000000003',
          balance: '1000000.00',
          currency: 'VND',
        }),
      );
      console.log('Created User 3 (Locked Customer)');
    }

    // 4. Seed Transaction History nhất quán với số dư (Hạng mục D)
    const acc1 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000001' },
    });
    const acc2 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000002' },
    });
    const acc3 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000003' },
    });

    if (!acc1 || !acc2 || !acc3) {
      throw new Error('Seed accounts not found!');
    }

    const existingTxCount = await queryRunner.manager.count(Transaction, {
      where: [
        { actor_account_id: acc1.id },
        { actor_account_id: acc2.id },
        { actor_account_id: acc3.id },
      ],
    });

    if (existingTxCount === 0) {
      const transactions: Transaction[] = [];
      const now = new Date();
      const initialDepositDate = new Date(
        now.getTime() - 60 * 24 * 60 * 60 * 1000,
      );

      // 4.1. Giao dịch nạp tiền khởi tạo (created_at sớm hơn mọi giao dịch khác)
      // Trong 25 giao dịch transfer bên dưới:
      // - A chuyển sang B (i chẵn: 0..24, 13 giao dịch): tổng 1,690,000.00
      // - B chuyển sang A (i lẻ: 1..23, 12 giao dịch): tổng 1,560,000.00
      // Biến động ròng từ transfer: A = -130,000.00; B = +130,000.00; C = 0.00
      // Do đó nạp khởi tạo: A = 5,130,000.00; B = 1,870,000.00; C = 1,000,000.00
      const initialDeposits = [
        { account: acc1, amount: '5130000.00' },
        { account: acc2, amount: '1870000.00' },
        { account: acc3, amount: '1000000.00' },
      ];

      for (const item of initialDeposits) {
        transactions.push(
          queryRunner.manager.create(Transaction, {
            actor_account_id: item.account.id,
            from_account_id: null,
            to_account_id: item.account.id,
            amount: item.amount,
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.SUCCESS,
            description: 'Số dư khởi tạo',
            idempotency_key: uuidv4(),
            created_at: initialDepositDate,
          }),
        );
      }

      // 4.2. 25 giao dịch chuyển khoản xen kẽ giữa Customer A và Customer B
      for (let i = 0; i < 25; i++) {
        const isAtoB = i % 2 === 0;
        const sender = isAtoB ? acc1 : acc2;
        const receiver = isAtoB ? acc2 : acc1;
        const txDate = new Date(now.getTime() - i * 2 * 24 * 60 * 60 * 1000);

        transactions.push(
          queryRunner.manager.create(Transaction, {
            actor_account_id: sender.id,
            from_account_id: sender.id,
            to_account_id: receiver.id,
            amount: ((i + 1) * 10000).toFixed(2),
            type: TransactionType.TRANSFER,
            status: TransactionStatus.SUCCESS,
            description: `Test transaction ${i + 1}`,
            idempotency_key: uuidv4(),
            created_at: txDate,
          }),
        );
      }

      await queryRunner.manager.save(transactions);
      console.log(
        'Created 3 Initial Deposits and 25 Mock Transfer Transactions',
      );
    }

    await queryRunner.commitTransaction();
    console.log('Seed completed successfully.');
  } catch (err) {
    await queryRunner.rollbackTransaction();
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await queryRunner.release();
    await AppDataSource.destroy();
  }
}

void runSeed();
