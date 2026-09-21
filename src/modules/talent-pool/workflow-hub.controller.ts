import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, SessionScoped } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  CreateAppointmentSlotsDto,
  RescheduleAppointmentDto,
  RescheduleAppointmentSlotDto,
  CreateWorkflowInstanceDto,
  CreateWorkflowFromTemplateDto,
  SaveWorkflowDraftDto,
  UpdateWorkflowDepartmentDto,
  UpdateWorkflowInstanceDto,
  UpdateAppointmentSlotStatusDto,
  UpdateAppointmentSlotDto,
  UpdateAppointmentStatusDto,
  UpdateRecruitmentApplicationDto,
  UpdateTalentPoolEntryDto,
  UpdateHumanServiceDto,
  UpdateWorkflowRecordDto,
  UpdateWorkflowIdentityContactDto,
  TestWorkflowProximityDto,
  IngestExternalRecordDto,
} from './dto/workflow-hub.dto';
import { WorkflowHubService } from './workflow-hub.service';
import { TalentPoolService } from './talent-pool.service';

@ApiTags('workflow-hub')
@Controller('sessions/:sessionId/workflow-hub')
@SessionScoped()
export class WorkflowHubController {
  constructor(
    private readonly service: WorkflowHubService,
    private readonly talentPoolService: TalentPoolService,
  ) {}

  @Get('runtime-status')
  @RequireRole(ApiKeyRole.OPERATOR)
  runtimeStatus(@Param('sessionId') sessionId: string) {
    return this.talentPoolService.getWorkflowHubRuntimeStatus(sessionId);
  }

  @Get('department')
  @RequireRole(ApiKeyRole.OPERATOR)
  department(@Param('sessionId') sessionId: string) {
    return this.service.getDepartment(sessionId);
  }

  @Put('department')
  @RequireRole(ApiKeyRole.ADMIN)
  updateDepartment(@Param('sessionId') sessionId: string, @Body() dto: UpdateWorkflowDepartmentDto) {
    return this.service.updateDepartment(sessionId, dto);
  }

  @Put('department/human-service')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateHumanService(@Param('sessionId') sessionId: string, @Body() dto: UpdateHumanServiceDto) {
    return this.service.setHumanServiceEnabled(sessionId, dto.enabled);
  }

  @Get('instances')
  @RequireRole(ApiKeyRole.OPERATOR)
  instances(@Param('sessionId') sessionId: string) {
    return this.service.listInstances(sessionId);
  }

  @Post('instances')
  @RequireRole(ApiKeyRole.ADMIN)
  create(@Param('sessionId') sessionId: string, @Body() dto: CreateWorkflowInstanceDto) {
    return this.service.createInstance(sessionId, dto);
  }

  @Get('templates')
  @RequireRole(ApiKeyRole.OPERATOR)
  templates(@Param('sessionId') sessionId: string) {
    void sessionId;
    return this.service.listTemplates();
  }

  @Post('templates/:key/create')
  @RequireRole(ApiKeyRole.ADMIN)
  createFromTemplate(
    @Param('sessionId') sessionId: string,
    @Param('key') key: string,
    @Body() dto: CreateWorkflowFromTemplateDto,
  ) {
    return this.service.createFromTemplate(sessionId, key, dto.name);
  }

  @Post('import-legacy-talent-pool')
  @RequireRole(ApiKeyRole.ADMIN)
  importLegacy(@Param('sessionId') sessionId: string) {
    return this.service.importLegacyTalentPool(sessionId);
  }

  @Put('instances/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  update(@Param('sessionId') sessionId: string, @Param('id') id: string, @Body() dto: UpdateWorkflowInstanceDto) {
    return this.service.updateInstance(sessionId, id, dto);
  }

  @Put('instances/:id/draft')
  @RequireRole(ApiKeyRole.ADMIN)
  draft(@Param('sessionId') sessionId: string, @Param('id') id: string, @Body() dto: SaveWorkflowDraftDto) {
    return this.service.saveDraft(sessionId, id, dto);
  }

  @Post('instances/:id/publish')
  @RequireRole(ApiKeyRole.ADMIN)
  publish(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.publish(sessionId, id);
  }

  @Post('instances/:id/pause')
  @RequireRole(ApiKeyRole.ADMIN)
  pause(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.pause(sessionId, id);
  }

  @Post('instances/:id/resume')
  @RequireRole(ApiKeyRole.ADMIN)
  resume(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.resume(sessionId, id);
  }

  @Post('instances/:id/archive')
  @RequireRole(ApiKeyRole.ADMIN)
  archive(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.archive(sessionId, id);
  }

  @Post('instances/:id/duplicate')
  @RequireRole(ApiKeyRole.ADMIN)
  duplicate(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.duplicate(sessionId, id);
  }

  @Get('instances/:id/slots')
  @RequireRole(ApiKeyRole.OPERATOR)
  slots(@Param('sessionId') sessionId: string, @Param('id') id: string, @Query('availableOnly') only?: string) {
    return this.service.listSlots(sessionId, id, only === 'true');
  }

  @Post('instances/:id/slots')
  @RequireRole(ApiKeyRole.OPERATOR)
  createSlots(@Param('sessionId') sessionId: string, @Param('id') id: string, @Body() dto: CreateAppointmentSlotsDto) {
    return this.service.createSlots(sessionId, id, dto);
  }

  @Patch('instances/:id/slots/:slotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateSlot(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateAppointmentSlotDto,
  ) {
    return this.service.updateSlot(sessionId, id, slotId, dto);
  }

  @Delete('instances/:id/slots/:slotId')
  @RequireRole(ApiKeyRole.OPERATOR)
  deleteSlot(@Param('sessionId') sessionId: string, @Param('id') id: string, @Param('slotId') slotId: string) {
    return this.service.deleteSlot(sessionId, id, slotId);
  }

  @Post('instances/:id/slots/:slotId/reschedule')
  @RequireRole(ApiKeyRole.OPERATOR)
  rescheduleSlot(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
    @Body() dto: RescheduleAppointmentSlotDto,
  ) {
    return this.service.rescheduleSlot(sessionId, id, slotId, dto);
  }

  @Post('instances/:id/slots/:slotId/block')
  @RequireRole(ApiKeyRole.OPERATOR)
  blockSlot(@Param('sessionId') sessionId: string, @Param('id') id: string, @Param('slotId') slotId: string) {
    return this.service.blockSlot(sessionId, id, slotId);
  }

  @Put('instances/:id/slots/:slotId/status')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateSlotStatus(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateAppointmentSlotStatusDto,
  ) {
    return this.service.updateSlotStatus(sessionId, id, slotId, dto.status);
  }

  @Get('instances/:id/appointments')
  @RequireRole(ApiKeyRole.OPERATOR)
  appointments(@Param('sessionId') sessionId: string, @Param('id') id: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.listAppointments(sessionId, id, key?.allowedChats ?? null);
  }

  @Post('instances/:id/records/:recordId/appointment')
  @RequireRole(ApiKeyRole.OPERATOR)
  scheduleRecordAppointment(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('recordId') recordId: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.scheduleRecordAppointment(sessionId, id, recordId, dto.targetSlotId, key?.allowedChats ?? null);
  }

  @Put('instances/:id/appointments/:appointmentId/status')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateAppointmentStatus(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: UpdateAppointmentStatusDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.updateAppointmentStatus(sessionId, id, appointmentId, dto.status, key?.allowedChats ?? null);
  }

  @Post('instances/:id/appointments/:appointmentId/reschedule')
  @RequireRole(ApiKeyRole.OPERATOR)
  rescheduleAppointment(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.rescheduleAppointment(
      sessionId,
      id,
      appointmentId,
      dto.targetSlotId,
      key?.allowedChats ?? null,
    );
  }

  @Get('recruitment-applications')
  @RequireRole(ApiKeyRole.OPERATOR)
  recruitmentApplications(@Param('sessionId') sessionId: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.listRecruitmentApplications(sessionId, key?.allowedChats ?? null);
  }

  @Patch('recruitment-applications/:applicationId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a recruitment application using optimistic concurrency control' })
  @ApiBadRequestResponse({ description: 'Invalid body, limits, or missing expectedVersion' })
  @ApiConflictResponse({ description: 'expectedVersion does not match the current application version' })
  updateRecruitmentApplication(
    @Param('sessionId') sessionId: string,
    @Param('applicationId') applicationId: string,
    @Body() dto: UpdateRecruitmentApplicationDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.updateRecruitmentApplication(
      sessionId,
      applicationId,
      dto,
      key?.id ?? null,
      key?.allowedChats ?? null,
    );
  }

  @Get('recruitment-applications/:applicationId/events')
  @RequireRole(ApiKeyRole.OPERATOR)
  recruitmentApplicationEvents(
    @Param('sessionId') sessionId: string,
    @Param('applicationId') applicationId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.listRecruitmentEvents(sessionId, applicationId, key?.allowedChats ?? null);
  }

  @Get('talent-pool')
  @RequireRole(ApiKeyRole.OPERATOR)
  talentPool(@Param('sessionId') sessionId: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.listTalentPoolEntries(sessionId, key?.allowedChats ?? null);
  }

  @Patch('talent-pool/:entryId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a talent-pool entry using optimistic concurrency control' })
  @ApiBadRequestResponse({ description: 'Invalid body, limits, or missing expectedVersion' })
  @ApiConflictResponse({ description: 'expectedVersion does not match the current talent-pool entry version' })
  updateTalentPoolEntry(
    @Param('sessionId') sessionId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateTalentPoolEntryDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.updateTalentPoolEntry(sessionId, entryId, dto, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Get('talent-pool/:entryId/events')
  @RequireRole(ApiKeyRole.OPERATOR)
  talentPoolEvents(
    @Param('sessionId') sessionId: string,
    @Param('entryId') entryId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.listTalentPoolEvents(sessionId, entryId, key?.allowedChats ?? null);
  }

  @Post('records/ingest')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Idempotently ingest an external workflow record',
    description:
      'contactId uses the same chat-id domain as API-key allowedChats, including individual JIDs and @g.us groups.',
  })
  @ApiBody({ type: IngestExternalRecordDto })
  @ApiBadRequestResponse({ description: 'Invalid event, contact identifier, or workflow answers' })
  @ApiConflictResponse({ description: 'Concurrent update or reused eventKey with a different payload' })
  ingestRecord(
    @Param('sessionId') sessionId: string,
    @Body() dto: IngestExternalRecordDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.ingestExternalRecord(sessionId, dto, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Get('records')
  @RequireRole(ApiKeyRole.OPERATOR)
  records(@Param('sessionId') sessionId: string, @Query('search') search?: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.listRecords(sessionId, search, key?.allowedChats ?? null);
  }

  @Patch('records/:recordId')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateRecord(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @Body() dto: UpdateWorkflowRecordDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.updateRecord(sessionId, recordId, dto, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Delete('records/:recordId')
  @RequireRole(ApiKeyRole.ADMIN)
  deleteRecord(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.deleteRecord(sessionId, recordId, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Patch('records/:recordId/contacts/:contactLinkId')
  @RequireRole(ApiKeyRole.OPERATOR)
  updateRecordContact(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @Param('contactLinkId') contactLinkId: string,
    @Body() dto: UpdateWorkflowIdentityContactDto,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.updateRecordContact(
      sessionId,
      recordId,
      contactLinkId,
      dto.phone,
      key?.id ?? null,
      key?.allowedChats ?? null,
    );
  }

  @Post('records/:recordId/contacts/:contactLinkId/primary')
  @RequireRole(ApiKeyRole.OPERATOR)
  setPrimaryRecordContact(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @Param('contactLinkId') contactLinkId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.setPrimaryRecordContact(
      sessionId,
      recordId,
      contactLinkId,
      key?.id ?? null,
      key?.allowedChats ?? null,
    );
  }

  @Delete('records/:recordId/contacts/:contactLinkId')
  @RequireRole(ApiKeyRole.OPERATOR)
  deleteRecordContact(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @Param('contactLinkId') contactLinkId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.deleteRecordContact(
      sessionId,
      recordId,
      contactLinkId,
      key?.id ?? null,
      key?.allowedChats ?? null,
    );
  }

  @Post('records/:recordId/proximity/recalculate')
  @RequireRole(ApiKeyRole.OPERATOR)
  recalculateRecordProximity(
    @Param('sessionId') sessionId: string,
    @Param('recordId') recordId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.recalculateRecordProximity(sessionId, recordId, key?.allowedChats ?? null);
  }

  @Post('proximity/test')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Test proximity providers without changing candidate data (ADMIN only)' })
  @ApiBadRequestResponse({ description: 'Invalid address' })
  @ApiForbiddenResponse({ description: 'ADMIN role required' })
  testProximity(@Param('sessionId') sessionId: string, @Body() dto: TestWorkflowProximityDto) {
    return this.service.testProximity(sessionId, dto.address);
  }

  @Get('tickets')
  @RequireRole(ApiKeyRole.OPERATOR)
  tickets(@Param('sessionId') sessionId: string, @Query('openOnly') openOnly?: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.listTickets(sessionId, openOnly === 'true', key?.allowedChats ?? null);
  }

  @Get('tickets/:ticketId/events')
  @RequireRole(ApiKeyRole.OPERATOR)
  ticketEvents(
    @Param('sessionId') sessionId: string,
    @Param('ticketId') ticketId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.listTicketEvents(sessionId, ticketId, key?.allowedChats ?? null);
  }

  @Post('tickets/:ticketId/activity')
  @RequireRole(ApiKeyRole.OPERATOR)
  touchTicket(
    @Param('sessionId') sessionId: string,
    @Param('ticketId') ticketId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.touchTicket(sessionId, ticketId, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Post('tickets/:ticketId/close')
  @RequireRole(ApiKeyRole.OPERATOR)
  closeTicket(
    @Param('sessionId') sessionId: string,
    @Param('ticketId') ticketId: string,
    @CurrentApiKey() key?: ApiKey,
  ) {
    return this.service.closeTicket(sessionId, ticketId, key?.id ?? null, key?.allowedChats ?? null);
  }

  @Get('indicators')
  @RequireRole(ApiKeyRole.OPERATOR)
  indicators(@Param('sessionId') sessionId: string) {
    return this.service.indicators(sessionId);
  }

  @Get('outbox-health')
  @RequireRole(ApiKeyRole.OPERATOR)
  outboxHealth(@Param('sessionId') sessionId: string) {
    return this.service.outboxHealth(sessionId);
  }

  @Post('outbox/:id/retry')
  @RequireRole(ApiKeyRole.OPERATOR)
  retryOutboxMessage(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.retryOutboxMessage(sessionId, id);
  }

  @Delete('outbox/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  discardOutboxMessage(@Param('sessionId') sessionId: string, @Param('id') id: string) {
    return this.service.discardOutboxMessage(sessionId, id);
  }

  @Get('deletion-requests')
  @RequireRole(ApiKeyRole.ADMIN)
  deletionRequests(@Param('sessionId') sessionId: string) {
    return this.service.listDeletionRequests(sessionId);
  }

  @Post('deletion-requests/:id/approve')
  @RequireRole(ApiKeyRole.ADMIN)
  approveDeletion(@Param('sessionId') sessionId: string, @Param('id') id: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.decideDeletion(sessionId, id, true, key?.id ?? null);
  }

  @Post('deletion-requests/:id/reject')
  @RequireRole(ApiKeyRole.ADMIN)
  rejectDeletion(@Param('sessionId') sessionId: string, @Param('id') id: string, @CurrentApiKey() key?: ApiKey) {
    return this.service.decideDeletion(sessionId, id, false, key?.id ?? null);
  }
}
