import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen the inbound ingress dedup key from (instanceId, providerDeliveryId) to
 * (pluginId, instanceId, providerDeliveryId).
 *
 * instanceId is a caller-supplied string that is only unique WITHIN a plugin, so two different plugins
 * sharing the same instanceId string would collide on the old 2-column unique index and a legitimate
 * delivery for the second plugin would be dropped as a false "duplicate". pluginId is already stored on
 * every row (recordOrSkip inserts it), so this is a pure loosening of the constraint — no data loss, no
 * false-negative risk. Kept as a stable-named DROP/CREATE unique index (portable to sqlite + postgres),
 * mirroring AddIntegrationFabric's index style.
 */
export class WidenIngressDedupKey1782100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ingress_events_instance_delivery"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ingress_events_instance_delivery" ON "ingress_events" ("pluginId", "instanceId", "providerDeliveryId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ingress_events_instance_delivery"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ingress_events_instance_delivery" ON "ingress_events" ("instanceId", "providerDeliveryId")`,
    );
  }
}
