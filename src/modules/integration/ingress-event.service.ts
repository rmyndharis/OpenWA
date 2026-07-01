import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';

// Cross-dialect unique-violation check by driver code/message — the two dialects we ship
// (sqlite dev, postgres prod). Add another branch if a third driver is ever supported.
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driver = err.driverError as { code?: string; message?: string } | undefined;
  const code = driver?.code ?? '';
  const message = driver?.message ?? err.message ?? '';
  return code === '23505' /* postgres */ || /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

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
