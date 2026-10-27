import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { User } from './entities/user.entity';
import { Account } from './entities/account.entity';
import { Transaction } from './entities/transaction.entity';
import { Baseline1710000000000 } from './migrations/1710000000000-Baseline';
import { AddDepositWithdrawAndIdempotencyScope1710000001000 } from './migrations/1710000001000-AddDepositWithdrawAndIdempotencyScope';
import { AddAccountVersionColumn1710000002000 } from './migrations/1710000002000-AddAccountVersionColumn';

const isTest = process.env.NODE_ENV === 'test';
dotenv.config({ path: isTest ? '.env.test' : '.env' });

if (isTest && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_secret_jwt_key_for_e2e';
}

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || (isTest ? '5433' : '5432'), 10),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database:
    process.env.DB_NAME || (isTest ? 'simple_bank_test' : 'simple_bank'),
  entities: [User, Account, Transaction],
  migrations: [
    Baseline1710000000000,
    AddDepositWithdrawAndIdempotencyScope1710000001000,
    AddAccountVersionColumn1710000002000,
  ],
  synchronize: false,
};

const AppDataSource = new DataSource(dataSourceOptions);
export default AppDataSource;