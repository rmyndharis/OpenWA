import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaTemplateFields1790770000000 implements MigrationInterface {
  name = 'AddMediaTemplateFields1790770000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "templates" ADD COLUMN "type" varchar(20) NOT NULL DEFAULT 'text'`);
    await queryRunner.query(`ALTER TABLE "templates" ADD COLUMN "mediaUrl" text`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "templates" DROP COLUMN "mediaUrl"`);
    await queryRunner.query(`ALTER TABLE "templates" DROP COLUMN "type"`);
  }
}
