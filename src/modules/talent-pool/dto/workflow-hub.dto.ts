import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import {
  ALLOWED_CHAT_ID_DESCRIPTION,
  ALLOWED_CHAT_ID_PATTERN,
  ALLOWED_CHAT_ID_PATTERN_SOURCE,
} from '../../../common/utils/chat-id';
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  DepartmentSchedule,
  WorkflowAppointmentNotificationEvent,
  WorkflowFieldDefinition,
} from '../entities/workflow-hub.entity';
import {
  AppointmentSlotStatus,
  AppointmentStatus,
  WorkflowInterviewPhase,
  WorkflowRecordMenuAction,
  WorkflowRecruitmentStatus,
  WorkflowTalentPoolStatus,
} from '../entities/workflow-hub.entity';

export class WorkflowRecordMenuItemDto {
  @IsEnum(WorkflowRecordMenuAction) action!: WorkflowRecordMenuAction;
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @ToStrictBoolean() @IsBoolean() enabled!: boolean;
}

export class WorkflowRecordMenuDto {
  @IsString() @MaxLength(120) title!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowRecordMenuItemDto)
  actions!: WorkflowRecordMenuItemDto[];
}

export class WorkflowCandidateTableColumnDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^(name|contact|flow|status|processStatus|updated|answer:.+)$/)
  id!: string;

  @ToStrictBoolean() @IsBoolean() visible!: boolean;
}

export class WorkflowAppointmentNotificationDto {
  @IsString() @MinLength(1) @MaxLength(80) id!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsString() @Matches(/^\d{1,3}$/) ddi!: string;
  @IsString() @Matches(/^\d{2,3}$/) ddd!: string;
  @IsString() @Matches(/^\d{6,10}$/) number!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @Matches(/^(CONFIRMADA|CANCELADA|REAGENDADA|CONCLUIDA)$/, { each: true })
  events!: WorkflowAppointmentNotificationEvent[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) locationIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsEnum(WorkflowInterviewPhase, { each: true })
  interviewPhases?: WorkflowInterviewPhase[];
  @IsOptional() @ToStrictBoolean() @IsBoolean() enabled?: boolean;
}

export class UpdateWorkflowDepartmentDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(80) timezone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10_080) menuTimeoutMinutes?: number;
  @IsOptional() @IsObject() schedule?: DepartmentSchedule;
  @IsOptional() @IsObject() messages?: Record<string, string>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @ValidateNested({ each: true })
  @Type(() => WorkflowCandidateTableColumnDto)
  candidateTableColumns?: WorkflowCandidateTableColumnDto[];
}

export class UpdateHumanServiceDto {
  @ToStrictBoolean() @IsBoolean() enabled!: boolean;
}

export class CreateWorkflowInstanceDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsArray() fields?: WorkflowFieldDefinition[];
  @IsOptional() @ValidateNested() @Type(() => WorkflowRecordMenuDto) recordMenu?: WorkflowRecordMenuDto;
}

export class CreateWorkflowFromTemplateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
}

export class UpdateWorkflowInstanceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(10_080) flowTimeoutMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) invalidAttemptLimit?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_080) humanInactivityMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_080) humanGraceMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(120) validityMonths?: number;
  @IsOptional() @IsInt() @Min(1024) @Max(104_857_600) pdfMaxBytes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) proactiveReminderDays?: number | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @Matches(/^\+?[\d\s().-]{10,30}$/, { each: true })
  appointmentNotificationNumbers?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WorkflowAppointmentNotificationDto)
  appointmentNotifications?: WorkflowAppointmentNotificationDto[];
  @IsOptional() @IsObject() messages?: Record<string, string>;
  @IsOptional() @ValidateNested() @Type(() => WorkflowRecordMenuDto) recordMenu?: WorkflowRecordMenuDto;
}

export class SaveWorkflowDraftDto {
  @IsArray() fields!: WorkflowFieldDefinition[];
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

export class CreateAppointmentSlotDto {
  @IsDateString() startsAt!: string;
  @IsOptional() @IsString() @MaxLength(160) label?: string;
  @IsOptional() @IsString() @MaxLength(100) locationId?: string;
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(1000) instruction?: string;
  @IsOptional() @IsString() @MaxLength(160) responsible?: string;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(1000) mapsUrl?: string;
  @IsOptional() @IsEnum(WorkflowInterviewPhase) interviewPhase?: WorkflowInterviewPhase;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
}

export class CreateAppointmentSlotsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAppointmentSlotDto)
  slots!: CreateAppointmentSlotDto[];
}

export class UpdateAppointmentSlotDto {
  @IsOptional() @IsString() @MaxLength(1000) instruction?: string;
  @IsOptional() @IsString() @MaxLength(160) responsible?: string;
  @IsOptional() @IsEnum(WorkflowInterviewPhase) interviewPhase?: WorkflowInterviewPhase;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
}

export class RescheduleAppointmentSlotDto {
  @IsDateString() startsAt!: string;
  @IsOptional() @IsString() @MaxLength(160) label?: string;
  @IsOptional() @IsString() @MaxLength(100) locationId?: string;
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(1000) instruction?: string;
  @IsOptional() @IsString() @MaxLength(160) responsible?: string;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(1000) mapsUrl?: string;
  @IsOptional() @IsEnum(WorkflowInterviewPhase) interviewPhase?: WorkflowInterviewPhase;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
}

export class RescheduleAppointmentDto {
  @IsString() @MinLength(1) @MaxLength(100) targetSlotId!: string;
}

export class UpdateAppointmentSlotStatusDto {
  @IsEnum(AppointmentSlotStatus) status!: AppointmentSlotStatus;
}

export class UpdateAppointmentStatusDto {
  @IsEnum(AppointmentStatus) status!: AppointmentStatus.CANCELLED | AppointmentStatus.COMPLETED;
}

export class UpdateRecruitmentApplicationDto {
  @ApiProperty({ minimum: 1, description: 'Current version used for optimistic concurrency control.' })
  @IsDefined()
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: WorkflowRecruitmentStatus })
  @IsOptional()
  @IsEnum(WorkflowRecruitmentStatus)
  status?: WorkflowRecruitmentStatus;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  rating?: number | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  nextActionAt?: string | null;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateTalentPoolEntryDto {
  @ApiProperty({ minimum: 1, description: 'Current version used for optimistic concurrency control.' })
  @IsDefined()
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: WorkflowTalentPoolStatus })
  @IsOptional()
  @IsEnum(WorkflowTalentPoolStatus)
  status?: WorkflowTalentPoolStatus;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  owner?: string | null;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateWorkflowRecordDto {
  /** Partial answers keyed by the current flow field answerKey. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  data!: Record<string, unknown>;

  /** Prevents one operator from silently overwriting a correction made by another. */
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class UpdateWorkflowIdentityContactDto {
  /** Canonical international phone number, digits only. */
  @ApiProperty({ pattern: '^\\d{10,15}$', example: '5511999990000' })
  @IsString()
  @Matches(/^\d{10,15}$/)
  phone!: string;
}

export class TestWorkflowProximityDto {
  /** Complete Brazilian address used only for this diagnostic request. */
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  address!: string;
}

export class IngestExternalRecordDto {
  /** Stable source event identifier, scoped to the workflow instance. */
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  eventKey!: string;

  /** Published workflow instance ID. */
  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  instanceId!: string;

  /**
   * Contact WhatsApp identifier. Individual ids and groups are accepted deliberately so this
   * contract matches ApiKey.allowedChats; engine-specific individual ids are normalized internally.
   */
  @ApiProperty({
    description: `${ALLOWED_CHAT_ID_DESCRIPTION} This is the same domain validated by API-key allowedChats.`,
    pattern: ALLOWED_CHAT_ID_PATTERN_SOURCE,
    example: '120363012345678901@g.us',
  })
  @IsString()
  @Matches(ALLOWED_CHAT_ID_PATTERN)
  contactId!: string;

  /** Answers keyed by field answerKey. Values: string, number, or string[] for multiselect. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  answers!: Record<string, unknown>;

  /** Optional human-readable channel tag stored in audit. */
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;
}
