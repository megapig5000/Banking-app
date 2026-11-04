import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableCheck,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

export class CreateIdempotencyKeysAndDropTransactionIdempotencyColumn1710000004000 implements MigrationInterface {
  name =
    'CreateIdempotencyKeysAndDropTransactionIdempotencyColumn1710000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tạo bảng idempotency_keys cùng enum idempotency_keys_status_enum
    await queryRunner.createTable(
      new Table({
        name: 'idempotency_keys',
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
            name: 'idempotency_key',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'request_hash',
            type: 'char',
            length: '64',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['IN_PROGRESS', 'COMPLETED', 'FAILED'],
            enumName: 'idempotency_keys_status_enum',
            default: `'IN_PROGRESS'`,
            isNullable: false,
          },
          {
            name: 'response_status',
            type: 'integer',
            isNullable: true,
          },
          {
            name: 'response_body',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'transaction_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
          {
            name: 'expired_at',
            type: 'timestamptz',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // 2. Tạo Unique (user_id, idempotency_key), Check constraint, Index (expired_at) và Foreign Keys
    await queryRunner.createUniqueConstraint(
      'idempotency_keys',
      new TableUnique({
        columnNames: ['user_id', 'idempotency_key'],
      }),
    );

    await queryRunner.createCheckConstraint(
      'idempotency_keys',
      new TableCheck({
        name: 'CHK_idempotency_keys_response_status',
        expression: `"status" = 'IN_PROGRESS' OR "response_status" IS NOT NULL`,
      }),
    );

    await queryRunner.createIndex(
      'idempotency_keys',
      new TableIndex({
        columnNames: ['expired_at'],
      }),
    );

    await queryRunner.createForeignKey(
      'idempotency_keys',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.createForeignKey(
      'idempotency_keys',
      new TableForeignKey({
        columnNames: ['transaction_id'],
        referencedTableName: 'transactions',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    // 3. Xóa Unique constraint cũ (idempotency_key, actor_account_id) và cột idempotency_key trên bảng transactions
    const txTable = await queryRunner.getTable('transactions');
    const oldUnique = txTable?.uniques.find((u) =>
      u.columnNames.includes('idempotency_key'),
    );
    if (oldUnique) {
      await queryRunner.dropUniqueConstraint('transactions', oldUnique);
    }

    const oldIndex = txTable?.indices.find((idx) =>
      idx.columnNames.includes('idempotency_key'),
    );
    if (oldIndex) {
      await queryRunner.dropIndex('transactions', oldIndex);
    }

    await queryRunner.dropColumn('transactions', 'idempotency_key');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Khôi phục cột idempotency_key và Unique constraint trên bảng transactions
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'idempotency_key',
        type: 'uuid',
        isNullable: true,
      }),
    );

    await queryRunner.createUniqueConstraint(
      'transactions',
      new TableUnique({
        columnNames: ['idempotency_key', 'actor_account_id'],
      }),
    );

    // 2. Xóa bảng idempotency_keys và kiểu enum
    await queryRunner.dropTable('idempotency_keys', true, true, true);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."idempotency_keys_status_enum"`,
    );
  }
}
