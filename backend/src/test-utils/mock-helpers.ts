import {
  Account,
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import {
  IdempotencyKey,
  IdempotencyKeyStatus,
} from '../database/entities/idempotency-key.entity';
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../database/entities/transaction.entity';
import { User, UserRole, UserStatus } from '../database/entities/user.entity';

/**
 * Builder tạo thực thể User mẫu có giá trị mặc định hợp lý, cho phép ghi đè từng trường.
 */
export function buildMockUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  user.full_name = overrides.full_name ?? 'Nguyen Van A';
  user.email = overrides.email ?? 'user1@bank.local';
  user.phone = overrides.phone !== undefined ? overrides.phone : null;
  user.profile_version = overrides.profile_version ?? 1;
  user.password_hash =
    overrides.password_hash ?? '$2b$10$mockhashedpasswordstring123456';
  user.role = overrides.role ?? UserRole.CUSTOMER;
  user.status = overrides.status ?? UserStatus.ACTIVE;
  user.created_at = overrides.created_at ?? new Date('2026-01-01T00:00:00Z');
  user.deleted_at =
    overrides.deleted_at !== undefined ? overrides.deleted_at : null;
  user.accounts = overrides.accounts ?? [];
  return user;
}

/**
 * Builder tạo thực thể Account mẫu có gắn sẵn User chủ tài khoản.
 */
export function buildMockAccount(overrides: Partial<Account> = {}): Account {
  const account = new Account();
  account.id = overrides.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  account.user_id =
    overrides.user_id ??
    overrides.user?.id ??
    '11111111-1111-4111-8111-111111111111';
  account.user = overrides.user ?? buildMockUser({ id: account.user_id });
  account.account_number = overrides.account_number ?? '1000000001';
  account.balance = overrides.balance ?? '5000000.00';
  account.hold_amount = overrides.hold_amount ?? '0.00';
  account.status = overrides.status ?? AccountStatus.ACTIVE;
  account.tier = overrides.tier ?? AccountTier.STANDARD;
  account.currency = overrides.currency ?? 'VND';
  account.created_at = overrides.created_at ?? new Date('2026-01-01T00:00:00Z');
  account.deleted_at =
    overrides.deleted_at !== undefined ? overrides.deleted_at : null;
  return account;
}

/**
 * Builder tạo thực thể Transaction mẫu.
 */
export function buildMockTransaction(
  overrides: Partial<Transaction> = {},
): Transaction {
  const tx = new Transaction();
  tx.id = overrides.id ?? 'tttttttt-tttt-4ttt-8ttt-tttttttttttt';
  tx.actor_account_id =
    overrides.actor_account_id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tx.from_account_id =
    overrides.from_account_id !== undefined
      ? overrides.from_account_id
      : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tx.to_account_id =
    overrides.to_account_id !== undefined
      ? overrides.to_account_id
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  tx.original_transaction_id =
    overrides.original_transaction_id !== undefined
      ? overrides.original_transaction_id
      : null;
  tx.amount = overrides.amount ?? '100000.00';
  tx.type = overrides.type ?? TransactionType.TRANSFER;
  tx.status = overrides.status ?? TransactionStatus.PROCESSING;
  tx.failure_code =
    overrides.failure_code !== undefined ? overrides.failure_code : null;
  tx.description =
    overrides.description !== undefined
      ? overrides.description
      : 'Giao dich thu nghiem';
  tx.created_at = overrides.created_at ?? new Date('2026-03-01T08:00:00Z');
  tx.updated_at = overrides.updated_at ?? new Date('2026-03-01T08:00:00Z');
  tx.fromAccount = overrides.fromAccount ?? null;
  tx.toAccount = overrides.toAccount ?? null;
  return tx;
}

/**
 * Builder tạo thực thể IdempotencyKey mẫu.
 */
export function buildMockIdempotencyKey(
  overrides: Partial<IdempotencyKey> = {},
): IdempotencyKey {
  const key = new IdempotencyKey();
  key.id = overrides.id ?? 'kkkkkkkk-kkkk-4kkk-8kkk-kkkkkkkkkkkk';
  key.user_id = overrides.user_id ?? '11111111-1111-4111-8111-111111111111';
  key.idempotency_key =
    overrides.idempotency_key ?? '550e8400-e29b-41d4-a716-446655440000';
  key.request_hash = overrides.request_hash ?? 'a'.repeat(64);
  key.status = overrides.status ?? IdempotencyKeyStatus.IN_PROGRESS;
  key.response_status =
    overrides.response_status !== undefined ? overrides.response_status : null;
  key.response_body =
    overrides.response_body !== undefined ? overrides.response_body : null;
  key.transaction_id =
    overrides.transaction_id !== undefined
      ? overrides.transaction_id
      : 'tttttttt-tttt-4ttt-8ttt-tttttttttttt';
  key.created_at = overrides.created_at ?? new Date('2026-03-01T08:00:00Z');
  key.expired_at = overrides.expired_at ?? new Date('2026-03-02T08:00:00Z');
  return key;
}

/**
 * Tạo đối tượng giả (mock) cho TypeORM QueryBuilder hỗ trợ method chaining.
 */
export function createMockQueryBuilder(overrides: Record<string, any> = {}) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getCount: jest.fn().mockResolvedValue(0),
    execute: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    ...overrides,
  };
  return qb;
}

/**
 * Tạo đối tượng giả (mock) cho TypeORM EntityManager.
 */
export function createMockEntityManager(overrides: Record<string, any> = {}) {
  const defaultQb = createMockQueryBuilder();
  const manager: Record<string, any> = {
    queryBuilder: defaultQb,
    createQueryBuilder: jest.fn(() => defaultQb),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((_entityClass: any, plainObject: any) => ({
      ...plainObject,
    })),
    save: jest.fn(async (_entityOrTarget: any, maybeEntity?: any) => {
      const entity = maybeEntity !== undefined ? maybeEntity : _entityOrTarget;
      return {
        id: 'tttttttt-tttt-4ttt-8ttt-tttttttttttt',
        created_at: new Date('2026-03-01T08:00:00Z'),
        updated_at: new Date('2026-03-01T08:00:00Z'),
        ...entity,
      };
    }),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    softRemove: jest.fn(async (_target: any, entity?: any) => {
      const targetEntity = entity !== undefined ? entity : _target;
      targetEntity.deleted_at = new Date('2026-03-01T09:00:00Z');
      return targetEntity;
    }),
    query: jest.fn().mockResolvedValue([{ used_today: '0.00' }]),
    ...overrides,
  };
  return manager;
}

/**
 * Tạo đối tượng giả (mock) cho TypeORM QueryRunner.
 */
export function createMockQueryRunner(manager = createMockEntityManager()) {
  const queryRunner = {
    manager,
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false;
    }),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  };
  return queryRunner;
}

/**
 * Tạo đối tượng giả (mock) cho TypeORM Repository.
 */
export function createMockRepository(overrides: Record<string, any> = {}) {
  const defaultQb = createMockQueryBuilder();
  const manager = createMockEntityManager({
    createQueryBuilder: jest.fn(() => defaultQb),
  });
  return {
    manager,
    queryBuilder: defaultQb,
    createQueryBuilder: jest.fn(() => defaultQb),
    findOne: jest.fn().mockResolvedValue(null),
    findOneByOrFail: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((plain: any) => ({ ...plain })),
    save: jest.fn(async (entity: any) => ({ id: 'mock-id', ...entity })),
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    ...overrides,
  };
}
