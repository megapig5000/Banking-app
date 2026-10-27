import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAccountVersionColumn1710000002000
  implements MigrationInterface
{
  name = 'AddAccountVersionColumn1710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'accounts',
      new TableColumn({
        name: 'version',
        type: 'int',
        default: 0,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('accounts', 'version');
  }
}