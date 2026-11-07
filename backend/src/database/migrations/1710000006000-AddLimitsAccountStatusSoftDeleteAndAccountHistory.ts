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

export class AddLimitsAccountStatusSoftDeleteAndAccountHistory1710000006000 implements MigrationInterface {
  name = 'AddLimitsAccountStatusSoftDeleteAndAccountHistory1710000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tạo enum cho accounts.status và accounts.tier
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_status_enum" AS ENUM('ACTIVE', 'FROZEN', 'CLOSED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."accounts_tier_enum" AS ENUM('STANDARD', 'VIP')`,
    );

    // 2. Thêm các cột mới vào bảng accounts: hold_amount, status, tier, deleted_at
    await queryRunner.addColumns('accounts', [
      new TableColumn({
        name: 'hold_amount',
        type: 'numeric',
        precision: 18,
        scale: 2,
        default: 0,
        isNullable: false,
      }),
      new TableColumn({
        name: 'status',
        type: 'enum',
        enum: ['ACTIVE', 'FROZEN', 'CLOSED'],
        enumName: 'accounts_status_enum',
        default: `'ACTIVE'`,
        isNullable: false,
      }),
      new TableColumn({
        name: 'tier',
        type: 'enum',
        enum: ['STANDARD', 'VIP'],
        enumName: 'accounts_tier_enum',
        default: `'STANDARD'`,
        isNullable: false,
      }),
      new TableColumn({
        name: 'deleted_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    ]);

    // Đảm bảo dữ liệu hiện có không có dòng nào âm trước khi gắn CHECK
    const invalidAccounts: Array<{ id: string }> = await queryRunner.query(
      `SELECT "id" FROM "accounts" WHERE "balance" < 0 OR "hold_amount" < 0 OR "hold_amount" > "balance"`,
    );
    if (invalidAccounts.length > 0) {
      throw new Error(
        `Cannot add CHECK constraints on accounts: found ${invalidAccounts.length} violating rows.`,
      );
    }

    // 3. Thêm 3 CHECK constraints bảo vệ số dư và hold_amount trên bảng accounts
    await queryRunner.createCheckConstraint(
      'accounts',
      new TableCheck({
        name: 'CHK_accounts_balance_non_negative',
        expression: `"balance" >= 0`,
      }),
    );

    await queryRunner.createCheckConstraint(
      'accounts',
      new TableCheck({
        name: 'CHK_accounts_hold_non_negative',
        expression: `"hold_amount" >= 0`,
      }),
    );

    await queryRunner.createCheckConstraint(
      'accounts',
      new TableCheck({
        name: 'CHK_accounts_hold_lte_balance',
        expression: `"hold_amount" <= "balance"`,
      }),
    );

    // Nếu DB dev đã seed sẵn tài khoản 1000000002 (Customer B), nâng hạng lên VIP để phục vụ demo
    await queryRunner.query(
      `UPDATE "accounts" SET "tier" = 'VIP' WHERE "account_number" = '1000000002'`,
    );

    // 4. Thêm các cột mới vào bảng users: phone, profile_version, deleted_at
    await queryRunner.addColumns('users', [
      new TableColumn({
        name: 'phone',
        type: 'varchar',
        length: '20',
        isNullable: true,
      }),
      new TableColumn({
        name: 'profile_version',
        type: 'integer',
        default: 1,
        isNullable: false,
      }),
      new TableColumn({
        name: 'deleted_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    ]);

    // 5. Tạo bảng account_history (cột id BIGSERIAL đồng bộ với @PrimaryGeneratedColumn({ type: 'bigint' }))
    await queryRunner.createTable(
      new Table({
        name: 'account_history',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'user_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'version',
            type: 'integer',
            isNullable: false,
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
            name: 'phone',
            type: 'varchar',
            length: '20',
            isNullable: true,
          },
          {
            name: 'changed_by_user_id',
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
      }),
      true,
    );

    await queryRunner.createUniqueConstraint(
      'account_history',
      new TableUnique({
        columnNames: ['user_id', 'version'],
      }),
    );

    await queryRunner.createIndex(
      'account_history',
      new TableIndex({
        columnNames: ['user_id', 'version'],
      }),
    );

    await queryRunner.createForeignKey(
      'account_history',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.createForeignKey(
      'account_history',
      new TableForeignKey({
        columnNames: ['changed_by_user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    // 6. Tạo Function và Trigger chặn UPDATE / DELETE trên bảng account_history (chỉ-ghi-thêm)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_account_history_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'account_history is append-only: % operation is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_account_history_immutable
      BEFORE UPDATE OR DELETE ON "account_history"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_account_history_modification();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Xóa Trigger, Function và bảng account_history
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_account_history_immutable ON "account_history"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS prevent_account_history_modification()`,
    );
    await queryRunner.dropTable('account_history', true, true, true);

    // 2. Xóa các cột đã thêm trên bảng users
    await queryRunner.dropColumn('users', 'deleted_at');
    await queryRunner.dropColumn('users', 'profile_version');
    await queryRunner.dropColumn('users', 'phone');

    // 3. Xóa 3 CHECK constraints và các cột đã thêm trên bảng accounts
    await queryRunner.dropCheckConstraint(
      'accounts',
      'CHK_accounts_hold_lte_balance',
    );
    await queryRunner.dropCheckConstraint(
      'accounts',
      'CHK_accounts_hold_non_negative',
    );
    await queryRunner.dropCheckConstraint(
      'accounts',
      'CHK_accounts_balance_non_negative',
    );

    await queryRunner.dropColumn('accounts', 'deleted_at');
    await queryRunner.dropColumn('accounts', 'tier');
    await queryRunner.dropColumn('accounts', 'status');
    await queryRunner.dropColumn('accounts', 'hold_amount');

    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."accounts_tier_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."accounts_status_enum"`,
    );
  }
}
