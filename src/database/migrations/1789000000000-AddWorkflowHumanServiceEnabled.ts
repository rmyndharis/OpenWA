import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Persists the department-wide availability of human handoff. */
export class AddWorkflowHumanServiceEnabled1789000000000 implements MigrationInterface {
  name = 'AddWorkflowHumanServiceEnabled1789000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'humanServiceEnabled')) return;
    const postgres = queryRunner.connection.options.type === 'postgres';
    await queryRunner.addColumn(
      'workflow_departments',
      new TableColumn({
        name: 'humanServiceEnabled',
        type: 'boolean',
        isNullable: false,
        default: postgres ? true : 1,
      }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'humanServiceEnabled'))
      await queryRunner.dropColumn('workflow_departments', 'humanServiceEnabled');
  }
}
