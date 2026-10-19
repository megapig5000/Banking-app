import { DataSource } from 'typeorm';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { Account } from './entities/account.entity';
import { Transaction, TransactionType, TransactionStatus } from './entities/transaction.entity';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Account, Transaction],
  synchronize: false,
});

async function runSeed() {
  await AppDataSource.initialize();
  console.log('Database connected. Starting seed...');

  const queryRunner = AppDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const passwordHash = await bcrypt.hash('Password@123', 10);

    // 1. Tạo Customer A
    let user1 = await queryRunner.manager.findOne(User, { where: { email: 'user1@bank.local' } });
    if (!user1) {
      user1 = queryRunner.manager.create(User, {
        full_name: 'Customer A', email: 'user1@bank.local', password_hash: passwordHash,
        role: UserRole.CUSTOMER, status: UserStatus.ACTIVE
      });
      user1 = await queryRunner.manager.save(user1);

      await queryRunner.manager.save(queryRunner.manager.create(Account, {
        user_id: user1.id, account_number: '1000000001', balance: '5000000.00', currency: 'VND'
      }));
      console.log('Created User 1 (Customer A)');
    }

    // 2. Tạo Customer B
    let user2 = await queryRunner.manager.findOne(User, { where: { email: 'user2@bank.local' } });
    if (!user2) {
      user2 = queryRunner.manager.create(User, {
        full_name: 'Customer B', email: 'user2@bank.local', password_hash: passwordHash,
        role: UserRole.CUSTOMER, status: UserStatus.ACTIVE
      });
      user2 = await queryRunner.manager.save(user2);

      await queryRunner.manager.save(queryRunner.manager.create(Account, {
        user_id: user2.id, account_number: '1000000002', balance: '2000000.00', currency: 'VND'
      }));
      console.log('Created User 2 (Customer B)');
    }

    // 3. Tạo Locked Customer
    let user3 = await queryRunner.manager.findOne(User, { where: { email: 'user3@bank.local' } });
    if (!user3) {
      user3 = queryRunner.manager.create(User, {
        full_name: 'Locked Customer', email: 'user3@bank.local', password_hash: passwordHash,
        role: UserRole.CUSTOMER, status: UserStatus.LOCKED
      });
      user3 = await queryRunner.manager.save(user3);

      await queryRunner.manager.save(queryRunner.manager.create(Account, {
        user_id: user3.id, account_number: '1000000003', balance: '1000000.00', currency: 'VND'
      }));
      console.log('Created User 3 (Locked Customer)');
    }

    // 4. Seed Transaction History (Cho test Filter/Pagination lượt 1C)
    const acc1 = await queryRunner.manager.findOne(Account, { where: { account_number: '1000000001' } });
    const acc2 = await queryRunner.manager.findOne(Account, { where: { account_number: '1000000002' } });

    if (!acc1 || !acc2) {
      throw new Error('Seed accounts not found!');
    }

    const txCount = await queryRunner.manager.count(Transaction, { where: { from_account_id: acc1.id } });
    if (txCount === 0) {
      const transactions = [];
      const now = new Date();
      // Tạo 25 giao dịch lùi dần về quá khứ, cách nhau 1-3 ngày
      for (let i = 0; i < 25; i++) {
        const isAtoB = i % 2 === 0;
        const txDate = new Date(now.getTime() - i * 2 * 24 * 60 * 60 * 1000);
        
        transactions.push(queryRunner.manager.create(Transaction, {
          from_account_id: isAtoB ? acc1.id : acc2.id,
          to_account_id: isAtoB ? acc2.id : acc1.id,
          amount: ((i + 1) * 10000).toFixed(2),
          type: TransactionType.TRANSFER,
          status: TransactionStatus.SUCCESS,
          description: `Test transaction ${i + 1}`,
          idempotency_key: uuidv4(),
          created_at: txDate
        }));
      }
      await queryRunner.manager.save(transactions);
      console.log('Created 25 Mock Transactions');
    }

    await queryRunner.commitTransaction();
    console.log('Seed completed successfully.');
  } catch (err) {
    await queryRunner.rollbackTransaction();
    console.error('Seed failed:', err);
  } finally {
    await queryRunner.release();
    await AppDataSource.destroy();
  }
}

runSeed();