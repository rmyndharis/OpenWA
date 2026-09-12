import { ApiProperty } from '@nestjs/swagger';

export class RemoteOpenWaQueueDepthDto {
  @ApiProperty({ description: 'Jobs waiting, active, delayed, or paused.', example: 3 })
  pending!: number;

  @ApiProperty({ description: 'Jobs delivered successfully.', example: 10 })
  completed!: number;

  @ApiProperty({ description: 'Jobs that exhausted their retries.', example: 1 })
  failed!: number;
}

export class RemoteOpenWaQueueItemDto {
  @ApiProperty({ description: 'Bull queue name on the remote OpenWA instance.', example: 'webhook-queue' })
  name!: string;

  @ApiProperty({ type: RemoteOpenWaQueueDepthDto })
  counts!: RemoteOpenWaQueueDepthDto;
}

export class RemoteOpenWaQueuesStatusDto {
  @ApiProperty({
    description: 'Whether remote OpenWA base URL and admin API key are configured.',
    example: true,
  })
  configured!: boolean;

  @ApiProperty({
    enum: ['bull-board', 'infra-status', 'unconfigured'],
    description: 'Which upstream endpoint supplied the queue depths.',
    example: 'bull-board',
  })
  source!: 'bull-board' | 'infra-status' | 'unconfigured';

  @ApiProperty({ type: [RemoteOpenWaQueueItemDto], description: 'Queue depths from the remote instance.' })
  queues!: RemoteOpenWaQueueItemDto[];
}
