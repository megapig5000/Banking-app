import AppDataSource from './data-source';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { Account, AccountStatus, AccountTier } from './entities/account.entity';
import {
  Transaction,
  TransactionType,
  TransactionStatus,
} from './entities/transaction.entity';
import * as bcrypt from 'bcrypt';

async function runSeed() {
  await AppDataSource.initialize();
  console.log('Database connected. Starting seed...');

  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const passwordHash = await bcrypt.hash('Password@123', 10);

    // 0. Tạo System Admin (phục vụ nghiệp vụ hoàn tiền REVERSAL & Admin APIs)
    let adminUser = await queryRunner.manager.findOne(User, {
      where: { email: 'admin@bank.local' },
      withDeleted: true,
    });
    if (!adminUser) {
      adminUser = queryRunner.manager.create(User, {
        full_name: 'System Admin',
        email: 'admin@bank.local',
        password_hash: passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
      });
      adminUser = await queryRunner.manager.save(adminUser);

      await queryRunner.manager.save(
        queryRunner.manager.create(Account, {
          user_id: adminUser.id,
          account_number: '1000000000',
          balance: '0.00',
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
          tier: AccountTier.STANDARD,
          currency: 'VND',
        }),
      );
      console.log('Created Admin User (admin@bank.local)');
    }

    // 1. Tạo Customer A (STANDARD)
    let user1 = await queryRunner.manager.findOne(User, {
      where: { email: 'user1@bank.local' },
      withDeleted: true,
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
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
          tier: AccountTier.STANDARD,
          currency: 'VND',
        }),
      );
      console.log('Created User 1 (Customer A - STANDARD)');
    }

    // 2. Tạo Customer B (VIP)
    let user2 = await queryRunner.manager.findOne(User, {
      where: { email: 'user2@bank.local' },
      withDeleted: true,
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
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
          tier: AccountTier.VIP,
          currency: 'VND',
        }),
      );
      console.log('Created User 2 (Customer B - VIP)');
    } else {
      // Đảm bảo tài khoản 1000000002 trên DB cũ cũng được đồng bộ tier = VIP
      await queryRunner.manager.update(
        Account,
        { account_number: '1000000002' },
        { tier: AccountTier.VIP },
      );
    }

    // 3. Tạo Locked Customer (STANDARD)
    let user3 = await queryRunner.manager.findOne(User, {
      where: { email: 'user3@bank.local' },
      withDeleted: true,
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
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
          tier: AccountTier.STANDARD,
          currency: 'VND',
        }),
      );
      console.log('Created User 3 (Locked Customer - STANDARD)');
    }

    // 4. Seed Transaction History nhất quán với số dư (dùng withDeleted: true để luôn tìm thấy tài khoản mẫu)
    const acc1 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000001' },
      withDeleted: true,
    });
    const acc2 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000002' },
      withDeleted: true,
    });
    const acc3 = await queryRunner.manager.findOne(Account, {
      where: { account_number: '1000000003' },
      withDeleted: true,
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
            status: TransactionStatus.COMPLETED,
            description: 'Số dư khởi tạo',
            created_at: initialDepositDate,
            updated_at: initialDepositDate,
          }),
        );
      }

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
            status: TransactionStatus.COMPLETED,
            description: `Test transaction ${i + 1}`,
            created_at: txDate,
            updated_at: txDate,
          }),
        );
      }

      await queryRunner.manager.save(transactions);
      console.log(
        'Created 3 Initial Deposits and 25 Mock Transfer Transactions',
      );
    }

    // 5. Đồng bộ bút toán sổ cái (ledger_entries) cho mọi giao dịch COMPLETED/REVERSED chưa có bút toán
    await queryRunner.query(`
      WITH raw_entries AS (
        SELECT
          t.from_account_id AS account_id,
          t.id AS transaction_id,
          'DEBIT'::"public"."ledger_entries_type_enum" AS type,
          t.amount AS amount,
          t.created_at AS created_at
        FROM "transactions" t
        WHERE t.status IN ('COMPLETED', 'REVERSED')
          AND t.from_account_id IS NOT NULL

        UNION ALL

        SELECT
          t.to_account_id AS account_id,
          t.id AS transaction_id,
          'CREDIT'::"public"."ledger_entries_type_enum" AS type,
          t.amount AS amount,
          t.created_at AS created_at
        FROM "transactions" t
        WHERE t.status IN ('COMPLETED', 'REVERSED')
          AND t.to_account_id IS NOT NULL
      ),
      ordered_entries AS (
        SELECT
          re.account_id,
          re.transaction_id,
          re.type,
          re.amount,
          SUM(
            CASE
              WHEN re.type = 'CREDIT'::"public"."ledger_entries_type_enum" THEN re.amount
              ELSE -re.amount
            END
          ) OVER (
            PARTITION BY re.account_id
            ORDER BY re.created_at ASC, re.transaction_id ASC, re.type ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS balance_after,
          re.created_at
        FROM raw_entries re
      )
      INSERT INTO "ledger_entries" (
        "account_id",
        "transaction_id",
        "type",
        "amount",
        "balance_after",
        "created_at"
      )
      SELECT
        oe.account_id,
        oe.transaction_id,
        oe.type,
        oe.amount,
        oe.balance_after,
        oe.created_at
      FROM ordered_entries oe
      WHERE NOT EXISTS (
        SELECT 1
        FROM "ledger_entries" le
        WHERE le.transaction_id = oe.transaction_id
          AND le.account_id = oe.account_id
          AND le.type = oe.type
      )
      ORDER BY oe.created_at ASC, oe.transaction_id ASC, oe.type ASC
    `);

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
