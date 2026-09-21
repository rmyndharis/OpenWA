import { MigrationInterface, QueryRunner } from 'typeorm';
import { completeWorkflowMessages } from '../../modules/talent-pool/workflow-messages';

export class BackfillWorkflowMessages1787500000000 implements MigrationInterface {
  name = 'BackfillWorkflowMessages1787500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_instances'))) return;
    const rows = (await queryRunner.query('SELECT "id", "messages" FROM "workflow_instances"')) as Array<{
      id: string;
      messages: string | Record<string, string> | null;
    }>;
    const postgres = queryRunner.connection.options.type === 'postgres';
    for (const row of rows) {
      let stored: Record<string, string>;
      try {
        stored =
          typeof row.messages === 'string'
            ? (JSON.parse(row.messages) as Record<string, string>)
            : (row.messages ?? {});
      } catch {
        stored = {};
      }
      const messages = JSON.stringify(completeWorkflowMessages(stored));
      await queryRunner.query(
        postgres
          ? 'UPDATE "workflow_instances" SET "messages" = $1 WHERE "id" = $2'
          : 'UPDATE "workflow_instances" SET "messages" = ? WHERE "id" = ?',
        [messages, row.id],
      );
    }
  }

  async down(): Promise<void> {
    // Existing custom messages cannot be distinguished safely from defaults after the backfill.
  }
}
