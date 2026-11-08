import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { User } from './entities/user.entity';
import { Account } from './entities/account.entity';
import { Transaction } from './entities/transaction.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { AuditLog } from './entities/audit-log.entity';
import { AccountHistory } from './entities/account-history.entity';
import { Baseline1710000000000 } from './migrations/1710000000000-Baseline';
import { AddDepositWithdrawAndIdempotencyScope1710000001000 } from './migrations/1710000001000-AddDepositWithdrawAndIdempotencyScope';
import { CreateLedgerEntriesWithBackfillAndTrigger1710000002000 } from './migrations/1710000002000-CreateLedgerEntriesWithBackfillAndTrigger';
import { UpgradeTransactionsStateMachineAndReversalSchema1710000003000 } from './migrations/1710000003000-UpgradeTransactionsStateMachineAndReversalSchema';
import { CreateIdempotencyKeysAndDropTransactionIdempotencyColumn1710000004000 } from './migrations/1710000004000-CreateIdempotencyKeysAndDropTransactionIdempotencyColumn';
import { UpgradeUserRoleEnumAndCreateAuditLogs1710000005000 } from './migrations/1710000005000-UpgradeUserRoleEnumAndCreateAuditLogs';
import { AddLimitsAccountStatusSoftDeleteAndAccountHistory1710000006000 } from './migrations/1710000006000-AddLimitsAccountStatusSoftDeleteAndAccountHistory';

const isTest = process.env.NODE_ENV === 'test';
dotenv.config({ path: isTest ? '.env.test' : '.env', quiet: true });

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
  entities: [
    User,
    Account,
    Transaction,
    LedgerEntry,
    IdempotencyKey,
    AuditLog,
    AccountHistory,
  ],
  migrations: [
    Baseline1710000000000,
    AddDepositWithdrawAndIdempotencyScope1710000001000,
    CreateLedgerEntriesWithBackfillAndTrigger1710000002000,
    UpgradeTransactionsStateMachineAndReversalSchema1710000003000,
    CreateIdempotencyKeysAndDropTransactionIdempotencyColumn1710000004000,
    UpgradeUserRoleEnumAndCreateAuditLogs1710000005000,
    AddLimitsAccountStatusSoftDeleteAndAccountHistory1710000006000,
  ],
  synchronize: false,
  // Tăng kích thước pool kết nối để chịu tải cao khi 100 request đồng thời đi qua 3 Pha
  extra: {
    max: 30,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  },
};

const AppDataSource = new DataSource(dataSourceOptions);
export default AppDataSource;