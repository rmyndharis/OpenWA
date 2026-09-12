import { ApiProperty } from '@nestjs/swagger';

export class OpenWaQueueDepthDto {
  @ApiProperty({ description: 'Jobs waiting, active, or delayed.', example: 3 })
  pending!: number;

  @ApiProperty({ description: 'Jobs completed successfully.', example: 10 })
  completed!: number;

  @ApiProperty({ description: 'Jobs that exhausted their retries.', example: 1 })
  failed!: number;
}

export class OpenWaQueueItemDto {
  @ApiProperty({ description: 'BullMQ queue name on this OpenWA instance.', example: 'webhook-queue' })
  name!: string;

  @ApiProperty({ type: OpenWaQueueDepthDto })
  counts!: OpenWaQueueDepthDto;
}

export class OpenWaQueuesStatusDto {
  @ApiProperty({
    description: 'Whether local job queues are enabled (QUEUE_ENABLED).',
    example: true,
  })
  configured!: boolean;

  @ApiProperty({
    enum: ['local', 'unconfigured'],
    description: 'Whether depths came from local BullMQ or queues are disabled.',
    example: 'local',
  })
  source!: 'local' | 'unconfigured';

  @ApiProperty({ type: [OpenWaQueueItemDto], description: 'Queue depths from this instance.' })
  queues!: OpenWaQueueItemDto[];
}
