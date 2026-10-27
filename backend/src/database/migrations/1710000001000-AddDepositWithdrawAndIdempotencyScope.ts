import {
  MigrationInterface,
  QueryRunner,
  TableCheck,
  TableColumn,
  TableForeignKey,
  TableUnique,
} from 'typeorm';

export class AddDepositWithdrawAndIdempotencyScope1710000001000 implements MigrationInterface {
  name = 'AddDepositWithdrawAndIdempotencyScope1710000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Cập nhật enum transactions_type_enum thêm 'withdraw'
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('transfer', 'deposit', 'withdraw')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum" USING "type"::"text"::"public"."transactions_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" SET DEFAULT 'transfer'`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);

    // 2. Cho phép to_account_id nullable (phục vụ giao dịch withdraw)
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "to_account_id" DROP NOT NULL`,
    );

    // 3. Thêm cột actor_account_id (nullable tạm thời để backfill nếu DB đã có dữ liệu)
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'actor_account_id',
        type: 'uuid',
        isNullable: true,
      }),
    );

    await queryRunner.query(
      `UPDATE "transactions" SET "actor_account_id" = COALESCE("from_account_id", "to_account_id") WHERE "actor_account_id" IS NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "actor_account_id" SET NOT NULL`,
    );

    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['actor_account_id'],
        referencedTableName: 'accounts',
        referencedColumnNames: ['id'],
      }),
    );

    // 4. Đổi Unique constraint từ (idempotency_key, from_account_id) sang (idempotency_key, actor_account_id)
    const table = await queryRunner.getTable('transactions');
    const oldUnique = table?.uniques.find(
      (u) =>
        u.columnNames.length === 2 &&
        u.columnNames.includes('idempotency_key') &&
        u.columnNames.includes('from_account_id'),
    );
    if (oldUnique) {
      await queryRunner.dropUniqueConstraint('transactions', oldUnique);
    }

    await queryRunner.createUniqueConstraint(
      'transactions',
      new TableUnique({
        columnNames: ['idempotency_key', 'actor_account_id'],
      }),
    );

    // 5. Thêm CHECK constraint bảo vệ tính toàn vẹn của from_account_id / to_account_id theo type
    await queryRunner.createCheckConstraint(
      'transactions',
      new TableCheck({
        name: 'CHK_transactions_type_accounts',
        expression: `("type" = 'transfer' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL AND "from_account_id" <> "to_account_id") OR ("type" = 'deposit' AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL) OR ("type" = 'withdraw' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL)`,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Xóa CHECK constraint
    await queryRunner.dropCheckConstraint(
      'transactions',
      'CHK_transactions_type_accounts',
    );

    // 2. Xóa các bản ghi không tương thích với schema cũ (withdraw hoặc deposit có from_account_id NULL)
    await queryRunner.query(
      `DELETE FROM "transactions" WHERE "type" = 'withdraw' OR "to_account_id" IS NULL`,
    );

    // 3. Khôi phục Unique constraint cũ
    const table = await queryRunner.getTable('transactions');
    const newUnique = table?.uniques.find(
      (u) =>
        u.columnNames.length === 2 &&
        u.columnNames.includes('idempotency_key') &&
        u.columnNames.includes('actor_account_id'),
    );
    if (newUnique) {
      await queryRunner.dropUniqueConstraint('transactions', newUnique);
    }

    await queryRunner.createUniqueConstraint(
      'transactions',
      new TableUnique({
        columnNames: ['idempotency_key', 'from_account_id'],
      }),
    );

    // 4. Xóa FK và cột actor_account_id
    const refreshedTable = await queryRunner.getTable('transactions');
    const actorFk = refreshedTable?.foreignKeys.find((fk) =>
      fk.columnNames.includes('actor_account_id'),
    );
    if (actorFk) {
      await queryRunner.dropForeignKey('transactions', actorFk);
    }
    await queryRunner.dropColumn('transactions', 'actor_account_id');

    // 5. Đặt lại NOT NULL cho to_account_id
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "to_account_id" SET NOT NULL`,
    );

    // 6. Khôi phục enum transactions_type_enum về ('transfer', 'deposit')
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('transfer', 'deposit')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum" USING "type"::"text"::"public"."transactions_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" SET DEFAULT 'transfer'`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);
  }
}
