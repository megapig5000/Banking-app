import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class Baseline1710000000000 implements MigrationInterface {
  name = 'Baseline1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1. Bảng users
    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'full_name',
            type: 'varchar',
            length: '100',
            isNullable: false,
          },
          {
            name: 'email',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'password_hash',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'role',
            type: 'enum',
            enum: ['customer', 'admin'],
            enumName: 'users_role_enum',
            default: `'customer'`,
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['active', 'locked'],
            enumName: 'users_status_enum',
            default: `'active'`,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
        ],
        uniques: [
          {
            columnNames: ['email'],
          },
        ],
      }),
      true,
    );

    // 2. Bảng accounts
    await queryRunner.createTable(
      new Table({
        name: 'accounts',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'user_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'account_number',
            type: 'varchar',
            length: '20',
            isNullable: false,
          },
          {
            name: 'balance',
            type: 'numeric',
            precision: 18,
            scale: 2,
            default: 0,
            isNullable: false,
          },
          {
            name: 'currency',
            type: 'varchar',
            length: '10',
            default: `'VND'`,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
        ],
        uniques: [
          {
            columnNames: ['account_number'],
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'accounts',
      new TableIndex({
        columnNames: ['user_id'],
      }),
    );

    await queryRunner.createForeignKey(
      'accounts',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
      }),
    );

    // 3. Bảng transactions
    await queryRunner.createTable(
      new Table({
        name: 'transactions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'from_account_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'to_account_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 18,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'type',
            type: 'enum',
            enum: ['transfer', 'deposit'],
            enumName: 'transactions_type_enum',
            default: `'transfer'`,
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['success', 'failed', 'pending'],
            enumName: 'transactions_status_enum',
            default: `'success'`,
            isNullable: false,
          },
          {
            name: 'description',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'idempotency_key',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
        ],
        uniques: [
          {
            columnNames: ['idempotency_key', 'from_account_id'],
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'transactions',
      new TableIndex({
        columnNames: ['from_account_id', 'created_at'],
      }),
    );

    await queryRunner.createIndex(
      'transactions',
      new TableIndex({
        columnNames: ['to_account_id', 'created_at'],
      }),
    );

    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['from_account_id'],
        referencedTableName: 'accounts',
        referencedColumnNames: ['id'],
      }),
    );

    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['to_account_id'],
        referencedTableName: 'accounts',
        referencedColumnNames: ['id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('transactions', true, true, true);
    await queryRunner.dropTable('accounts', true, true, true);
    await queryRunner.dropTable('users', true, true, true);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."transactions_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."transactions_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_role_enum"`);
  }
}
