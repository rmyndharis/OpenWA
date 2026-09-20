import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TalentCandidate,
  TalentFlowSession,
  TalentPoolSettings,
  TalentProcessedMessage,
  TalentTicket,
  TalentTicketEvent,
} from './entities/talent-pool.entity';
import { TalentPoolService } from './talent-pool.service';
import { WorkflowHubController } from './workflow-hub.controller';
import { WorkflowHubService } from './workflow-hub.service';
import {
  WorkflowAppointment,
  WorkflowAppointmentSlot,
  WorkflowConsent,
  WorkflowDefinitionVersion,
  WorkflowDeletionRequest,
  WorkflowDepartment,
  WorkflowInstance,
  WorkflowIdentity,
  WorkflowIdentityContact,
  WorkflowOutboxMessage,
  WorkflowPrivacyEvent,
  WorkflowRecord,
  WorkflowRecordVersion,
  WorkflowRecruitmentApplication,
  WorkflowRecruitmentEvent,
  WorkflowTalentPoolEntry,
  WorkflowTalentPoolEvent,
  WorkflowRun,
  WorkflowTicket,
  WorkflowTicketEvent,
} from './entities/workflow-hub.entity';

export const TALENT_POOL_ENTITIES = [
  TalentPoolSettings,
  TalentCandidate,
  TalentFlowSession,
  TalentTicket,
  TalentTicketEvent,
  TalentProcessedMessage,
  WorkflowDepartment,
  WorkflowInstance,
  WorkflowIdentity,
  WorkflowIdentityContact,
  WorkflowDefinitionVersion,
  WorkflowRun,
  WorkflowRecord,
  WorkflowRecordVersion,
  WorkflowConsent,
  WorkflowDeletionRequest,
  WorkflowAppointmentSlot,
  WorkflowAppointment,
  WorkflowRecruitmentApplication,
  WorkflowRecruitmentEvent,
  WorkflowTalentPoolEntry,
  WorkflowTalentPoolEvent,
  WorkflowOutboxMessage,
  WorkflowTicket,
  WorkflowTicketEvent,
  WorkflowPrivacyEvent,
];

@Module({
  imports: [TypeOrmModule.forFeature(TALENT_POOL_ENTITIES, 'data')],
  // The legacy service remains registered only so existing installations can be migrated.
  // Its HTTP controller is intentionally no longer exposed: workflow-hub is the single API surface.
  controllers: [WorkflowHubController],
  providers: [TalentPoolService, WorkflowHubService],
  exports: [TalentPoolService, WorkflowHubService],
})
export class TalentPoolModule {}
