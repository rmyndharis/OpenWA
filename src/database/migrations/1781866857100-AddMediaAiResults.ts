import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMediaAiResults1781866857100 implements MigrationInterface {
    name = 'AddMediaAiResults1781866857100'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "media_ai_results" ("id" varchar PRIMARY KEY NOT NULL, "messageId" varchar NOT NULL, "sessionId" varchar NOT NULL, "mediaType" varchar NOT NULL, "transcription" text, "ocrText" text, "imageDescription" text, "moderationFlagged" boolean, "moderationCategories" text, "detectedLanguage" varchar, "processingTimeMs" integer, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_media_ai_results_messageId" ON "media_ai_results" ("messageId")`);
        await queryRunner.query(`CREATE INDEX "IDX_media_ai_results_sessionId" ON "media_ai_results" ("sessionId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_media_ai_results_sessionId"`);
        await queryRunner.query(`DROP INDEX "IDX_media_ai_results_messageId"`);
        await queryRunner.query(`DROP TABLE "media_ai_results"`);
    }
}
