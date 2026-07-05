import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { isUniqueViolation } from '../../common/utils/db-errors';

export interface IngressEventInput {
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };
  sessionId: string | null;
}

@Injectable()
export class IngressEventService {
  constructor(@InjectRepository(IngressEvent, 'data') private readonly repo: Repository<IngressEvent>) {}

  // Persist-before-ack + dedup. true = newly recorded (enqueue it); false = duplicate (drop, already handled).
  async recordOrSkip(input: IngressEventInput): Promise<boolean> {
    try {
      await this.repo.insert({ id: randomUUID(), ...input });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}
