import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/** Adds provider-neutral derived content beside messages without parsing legacy metadata. */
export class AddMessageAnnotations1782600000000 implements MigrationInterface {
  name = 'AddMessageAnnotations1782600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('message_annotations')) return;
    const dateType = queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
    await queryRunner.createTable(
      new Table({
        name: 'message_annotations',
        columns: [
          { name: 'sessionId', type: 'varchar', isPrimary: true },
          { name: 'messageId', type: 'varchar', isPrimary: true },
          { name: 'provider', type: 'varchar', length: '128', isPrimary: true },
          { name: 'kind', type: 'varchar', length: '32', isPrimary: true },
          { name: 'status', type: 'varchar', length: '32' },
          { name: 'language', type: 'varchar', length: '35', isNullable: true },
          { name: 'text', type: 'text', isNullable: true },
          { name: 'mediaFingerprint', type: 'varchar', length: '64', isNullable: true },
          { name: 'processorVersion', type: 'varchar', length: '128' },
          { name: 'externalProcessing', type: 'boolean' },
          { name: 'metadata', type: 'text', isNullable: true },
          { name: 'createdAt', type: dateType, default: 'CURRENT_TIMESTAMP' },
          { name: 'expiresAt', type: dateType, isNullable: true },
        ],
      }),
    );
    await queryRunner.createIndex(
      'message_annotations',
      new TableIndex({ name: 'IDX_message_annotations_session_message', columnNames: ['sessionId', 'messageId'] }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('message_annotations')) await queryRunner.dropTable('message_annotations');
  }
}
