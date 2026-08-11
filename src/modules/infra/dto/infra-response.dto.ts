import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the infrastructure routes. These describe what the handlers already return —
 * the payload is the raw handler value, not an envelope — so that a change to the shape shows up as
 * a diff in the committed OpenAPI snapshot instead of reaching clients unannounced.
 *
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

// ---------- GET /infra/status ----------

export class InfraDatabaseStatusDto {
  @ApiProperty({ description: 'Whether a `SELECT 1` probe succeeded just now.', example: true })
  connected!: boolean;

  @ApiProperty({ description: 'Configured driver.', example: 'postgres' })
  type!: string;

  @ApiProperty({ description: 'Host the app is configured to reach.', example: 'openwa-postgres' })
  host!: string;

  @ApiProperty({
    description:
      "Whether OpenWA's own bundled container is actually running and backing this service, " +
      'detected live from the labelled container rather than read from the saved intent. Falls back ' +
      'to the saved flag when Docker is unavailable.',
    example: true,
  })
  builtIn!: boolean;
}

export class InfraRedisStatusDto {
  @ApiProperty({ description: 'Whether Redis is switched on in configuration.', example: true })
  enabled!: boolean;

  @ApiProperty({ description: 'Whether a live probe reached it.', example: true })
  connected!: boolean;

  @ApiProperty({ example: 'openwa-redis' })
  host!: string;

  @ApiProperty({ example: 6379 })
  port!: number;

  @ApiProperty({ description: "Whether OpenWA's bundled Redis container is backing this.", example: true })
  builtIn!: boolean;
}

export class InfraQueueDepthDto {
  @ApiProperty({ description: 'Jobs waiting to be delivered.', example: 0 })
  pending!: number;

  @ApiProperty({ description: 'Jobs delivered successfully.', example: 128 })
  completed!: number;

  @ApiProperty({ description: 'Jobs that exhausted their retries.', example: 2 })
  failed!: number;
}

export class InfraQueueStatusDto {
  @ApiProperty({ description: 'Whether queue processing is switched on.', example: true })
  enabled!: boolean;

  @ApiProperty({ type: InfraQueueDepthDto, description: 'Webhook queue depths.' })
  webhooks!: InfraQueueDepthDto;
}

export class InfraStorageStatusDto {
  @ApiProperty({ enum: ['local', 's3'], example: 'local' })
  type!: string;

  @ApiPropertyOptional({ description: 'Local storage root. Present only for `local`.', example: './data/storage' })
  path?: string;

  @ApiPropertyOptional({ description: 'Bucket name. Present only for `s3`.', example: 'openwa-media' })
  bucket?: string;

  @ApiProperty({ description: "Whether OpenWA's bundled MinIO container is backing this.", example: false })
  builtIn!: boolean;

  @ApiPropertyOptional({ description: 'Whether the S3 endpoint answered a probe. Present only for `s3`.' })
  s3Available?: boolean;
}

export class InfraEngineStatusDto {
  @ApiProperty({ description: 'Active engine.', example: 'baileys' })
  type!: string;

  @ApiProperty({ description: 'Whether Chromium runs headless. Meaningful for whatsapp-web.js only.', example: true })
  headless!: boolean;

  @ApiProperty({ example: './data/sessions' })
  sessionDataPath!: string;

  @ApiProperty({ description: 'Extra Chromium arguments, as configured.', example: '' })
  browserArgs!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'whatsapp-web.js only: the WhatsApp Web build actually in use, which is distinct from the ' +
      'library version. Omitted for other engines.',
    example: '2.3000.1234567890',
  })
  webVersion?: string | null;

  @ApiPropertyOptional({
    enum: ['pinned', 'auto', 'native'],
    description: 'How that build was chosen. Omitted for other engines.',
    example: 'pinned',
  })
  webVersionSource?: string;
}

export class InfraStatusResponseDto {
  @ApiProperty({ type: InfraDatabaseStatusDto })
  database!: InfraDatabaseStatusDto;

  @ApiProperty({ type: InfraRedisStatusDto })
  redis!: InfraRedisStatusDto;

  @ApiProperty({ type: InfraQueueStatusDto })
  queue!: InfraQueueStatusDto;

  @ApiProperty({ type: InfraStorageStatusDto })
  storage!: InfraStorageStatusDto;

  @ApiProperty({ type: InfraEngineStatusDto })
  engine!: InfraEngineStatusDto;

  @ApiProperty({
    type: [String],
    description:
      'Which of the four settings the dashboard can edit are supplied by a layer ABOVE ' +
      '`data/.env.generated` — the container environment or a project `.env` — and so cannot be ' +
      'changed from the dashboard until that layer is. Reported, not inferred from a running-vs-saved ' +
      'mismatch: a save that has not been restarted yet looks identical and needs the opposite advice.',
    example: ['ENGINE_TYPE'],
  })
  envPinned!: string[];
}

// ---------- GET /infra/health, /infra/engines, /infra/engines/current ----------

export class InfraHealthResponseDto {
  @ApiProperty({ description: 'Liveness marker. This route does not probe dependencies.', example: 'ok' })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the reply.', example: '2026-08-07T12:00:00.000Z' })
  timestamp!: string;
}

export class EngineLibraryDto {
  @ApiProperty({
    description: "The underlying library, distinct from the engine plugin's own manifest name.",
    example: 'whatsapp-web.js',
  })
  name!: string;

  @ApiProperty({ description: 'Library version actually loaded.', example: '1.34.7' })
  version!: string;
}

export class AvailableEngineDto {
  @ApiProperty({ description: 'Engine plugin id — the value ENGINE_TYPE takes.', example: 'baileys' })
  id!: string;

  @ApiProperty({ description: 'Display name from the plugin manifest.', example: 'Baileys' })
  name!: string;

  @ApiProperty({ description: 'Whether the plugin is enabled. Disabled engines are still listed.', example: true })
  enabled!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Capabilities the engine declares.',
    example: ['text-messages', 'media-messages', 'group-management'],
  })
  features!: string[];

  @ApiPropertyOptional({
    type: EngineLibraryDto,
    description: 'Absent when the plugin does not report a library, which includes any disabled engine.',
  })
  library?: EngineLibraryDto;
}

export class InfraCurrentEngineResponseDto {
  @ApiProperty({ description: 'Engine the process resolved at boot.', example: 'baileys' })
  engineType!: string;
}

// ---------- GET /infra/config ----------

export class InfraConfigDatabaseDto {
  @ApiProperty({ enum: ['sqlite', 'postgres'], example: 'postgres' })
  type!: string;

  @ApiProperty({ example: true })
  builtIn!: boolean;

  @ApiProperty({ example: 'openwa-postgres' })
  host!: string;

  @ApiProperty({ description: 'Kept as a string: it is echoed back from the saved env verbatim.', example: '5432' })
  port!: string;

  @ApiProperty({ example: 'openwa' })
  username!: string;

  @ApiProperty({ description: 'Database name, or the SQLite file path.', example: 'openwa' })
  database!: string;

  @ApiProperty({ example: 'public' })
  schema!: string;

  @ApiProperty({ example: 10 })
  poolSize!: number;

  @ApiProperty({ example: false })
  sslEnabled!: boolean;

  @ApiProperty({ example: true })
  sslRejectUnauthorized!: boolean;

  @ApiProperty({ description: 'Whether a password is stored. The secret itself is never returned.', example: true })
  passwordSet!: boolean;
}

export class InfraConfigRedisDto {
  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: true })
  builtIn!: boolean;

  @ApiProperty({ example: 'openwa-redis' })
  host!: string;

  @ApiProperty({ description: 'Echoed from the saved env verbatim.', example: '6379' })
  port!: string;

  @ApiProperty({ description: 'Whether a password is stored. The secret itself is never returned.', example: false })
  passwordSet!: boolean;
}

export class InfraConfigQueueDto {
  @ApiProperty({ example: true })
  enabled!: boolean;
}

export class InfraConfigStorageDto {
  @ApiProperty({ enum: ['local', 's3'], example: 'local' })
  type!: string;

  @ApiProperty({ example: false })
  builtIn!: boolean;

  @ApiProperty({ example: './data/storage' })
  localPath!: string;

  @ApiProperty({ example: '' })
  s3Bucket!: string;

  @ApiProperty({ example: '' })
  s3Region!: string;

  @ApiProperty({ example: '' })
  s3Endpoint!: string;

  @ApiProperty({
    description: 'Whether both an access key id and a secret are stored. Neither is ever returned.',
    example: false,
  })
  s3CredentialsSet!: boolean;
}

export class InfraConfigEngineDto {
  @ApiProperty({ example: 'whatsapp-web.js' })
  type!: string;

  @ApiProperty({ example: true })
  headless!: boolean;

  @ApiProperty({ example: './data/sessions' })
  sessionDataPath!: string;

  @ApiProperty({ example: '' })
  browserArgs!: string;
}

export class InfraConfigResponseDto {
  @ApiProperty({ type: InfraConfigDatabaseDto })
  database!: InfraConfigDatabaseDto;

  @ApiProperty({ type: InfraConfigRedisDto })
  redis!: InfraConfigRedisDto;

  @ApiProperty({ type: InfraConfigQueueDto })
  queue!: InfraConfigQueueDto;

  @ApiProperty({ type: InfraConfigStorageDto })
  storage!: InfraConfigStorageDto;

  @ApiProperty({ type: InfraConfigEngineDto })
  engine!: InfraConfigEngineDto;
}

export class InfraConfigSaveResponseDto {
  @ApiProperty({ example: 'Configuration saved successfully. Server restart required to apply changes.' })
  message!: string;

  @ApiProperty({
    description:
      'False when the write failed. This route answers 200 either way, so a client must read this ' +
      'flag rather than the status code.',
    example: true,
  })
  saved!: boolean;

  @ApiProperty({
    description: 'Path of the env file written, relative to the working directory so the host layout is not disclosed.',
    example: 'data/.env.generated',
  })
  envPath!: string;

  @ApiProperty({ type: [String], description: 'Docker profiles the saved selection requires.', example: ['postgres'] })
  profiles!: string[];
}

// ---------- POST /infra/restart ----------

export class InfraRestartResponseDto {
  @ApiProperty({ example: 'Restart scheduled.' })
  message!: string;

  @ApiProperty({ description: 'Whether a restart was actually scheduled.', example: true })
  restarting!: boolean;

  @ApiProperty({ type: [String], description: 'Docker profiles to bring up.', example: ['postgres'] })
  profiles!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Profiles to tear down. Teardown is stop-only: containers are stopped and retained for ' +
      're-enable, never deleted.',
    example: [],
  })
  profilesToRemove!: string[];

  @ApiProperty({ description: 'Rough seconds before the process is expected back.', example: 15 })
  estimatedTime!: number;

  @ApiPropertyOptional({
    type: Object,
    description: 'Raw per-service orchestration outcome, present only when profiles were started.',
  })
  orchestration?: object;

  @ApiPropertyOptional({
    type: Object,
    description: 'Raw per-service stop outcome, present only when profiles were torn down.',
  })
  removal?: object;
}

// ---------- GET /infra/export-data, POST /infra/import-data ----------

/**
 * One array per table. The row shapes are deliberately not enumerated: this is the backup/restore
 * migration payload, mirroring the database entities, not a public data model — spelling every row
 * out here would duplicate those definitions and drift from them. The table NAMES are pinned, so
 * adding or dropping a table still shows up as a contract diff.
 */
export class MigrationTablesDto {
  @ApiProperty({ type: [Object] }) sessions!: object[];
  @ApiProperty({ type: [Object] }) webhooks!: object[];
  @ApiProperty({ type: [Object] }) messages!: object[];
  @ApiProperty({ type: [Object] }) messageBatches!: object[];
  @ApiProperty({ type: [Object] }) templates!: object[];
  @ApiProperty({ type: [Object] }) baileysStoredMessages!: object[];
  @ApiProperty({ type: [Object] }) lidMappings!: object[];
  @ApiProperty({ type: [Object] }) pluginInstances!: object[];
  @ApiProperty({ type: [Object] }) conversationMappings!: object[];
  @ApiProperty({ type: [Object] }) ingressEvents!: object[];
  @ApiProperty({ type: [Object] }) webhookDeliveryFailures!: object[];
  @ApiProperty({ type: [Object] }) integrationDeliveryFailures!: object[];
  @ApiProperty({ type: [Object] }) statusUpdates!: object[];
  @ApiProperty({ type: [Object] }) automationRules!: object[];
}

/** Row count per table, with the same keys as {@link MigrationTablesDto}. */
export class TableCountsDto {
  @ApiProperty({ example: 2 }) sessions!: number;
  @ApiProperty({ example: 1 }) webhooks!: number;
  @ApiProperty({ example: 1024 }) messages!: number;
  @ApiProperty({ example: 0 }) messageBatches!: number;
  @ApiProperty({ example: 3 }) templates!: number;
  @ApiProperty({ example: 512 }) baileysStoredMessages!: number;
  @ApiProperty({ example: 64 }) lidMappings!: number;
  @ApiProperty({ example: 12 }) pluginInstances!: number;
  @ApiProperty({ example: 8 }) conversationMappings!: number;
  @ApiProperty({ example: 40 }) ingressEvents!: number;
  @ApiProperty({ example: 0 }) webhookDeliveryFailures!: number;
  @ApiProperty({ example: 0 }) integrationDeliveryFailures!: number;
  @ApiProperty({ example: 5 }) statusUpdates!: number;
  @ApiProperty({ example: 2 }) automationRules!: number;
}

export class OmittedInlineMediaDto {
  @ApiProperty({ description: 'Message attachments replaced with an omitted marker.', example: 0 })
  messages!: number;

  @ApiProperty({ description: 'Batch attachments replaced with an omitted marker.', example: 0 })
  messageBatches!: number;
}

export class InfraExportDataResponseDto {
  @ApiProperty({ description: 'ISO-8601 timestamp the export was taken.', example: '2026-08-07T12:00:00.000Z' })
  exportedAt!: string;

  @ApiProperty({ description: 'Driver the data came from.', example: 'postgres' })
  dataDbType!: string;

  @ApiProperty({ type: MigrationTablesDto })
  tables!: MigrationTablesDto;

  @ApiProperty({ type: TableCountsDto, description: 'Row counts, so a truncated restore is detectable.' })
  counts!: TableCountsDto;

  @ApiProperty({
    type: [String],
    description:
      'Tables the running database does not have, which were skipped rather than exported. A restore ' +
      'from this file will not repopulate them.',
    example: [],
  })
  skippedTables!: string[];

  @ApiProperty({
    type: OmittedInlineMediaDto,
    description:
      'Inline media dropped for exceeding the export budget. Non-zero means the archive is TRUNCATED — ' +
      'the rows are present but their attachments are replaced with an omitted marker.',
  })
  omittedInlineMedia!: OmittedInlineMediaDto;
}

export class InfraImportDataResponseDto {
  @ApiProperty({ example: true })
  imported!: boolean;

  @ApiProperty({ type: TableCountsDto, description: 'Rows written per table.' })
  counts!: TableCountsDto;

  @ApiProperty({ type: [String], description: 'Problems that did not stop the import.', example: [] })
  warnings!: string[];

  @ApiProperty({ type: [String], description: 'Informational messages about what the import did.', example: [] })
  notices!: string[];

  @ApiProperty({ description: 'Whether the process must restart before the imported state is live.', example: true })
  restartRequired!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Sessions running here that the imported set does not contain — they were about to be deleted.',
    example: [],
  })
  orphanedEngines!: string[];

  @ApiProperty({ type: [String], description: 'Of those, the ones successfully stopped.', example: [] })
  stoppedOrphanEngines!: string[];

  @ApiProperty({ type: [String], description: 'Of those, the ones that could not be stopped.', example: [] })
  failedOrphanEngines!: string[];
}

// ---------- /infra/storage/* ----------

export class StorageFileCountResponseDto {
  @ApiProperty({ enum: ['local', 's3'], example: 'local' })
  storageType!: string;

  @ApiProperty({ description: 'Number of stored objects.', example: 128 })
  count!: number;

  @ApiProperty({ description: 'Total size in bytes.', example: 10485760 })
  sizeBytes!: number;

  @ApiProperty({ description: 'The same size in MB, pre-rendered to two decimals.', example: '10.00' })
  sizeMB!: string;
}

export class StorageExportResponseDto {
  @ApiProperty({ example: 'Storage archive created.' })
  message!: string;

  @ApiProperty({ description: 'Path to download the archive from.', example: '/api/infra/storage/download/xyz.tar' })
  download!: string;
}

export class StorageImportResponseDto {
  @ApiProperty({ example: true })
  imported!: boolean;

  @ApiProperty({ description: 'Objects written.', example: 128 })
  count!: number;

  @ApiProperty({ enum: ['local', 's3'], example: 'local' })
  storageType!: string;
}
