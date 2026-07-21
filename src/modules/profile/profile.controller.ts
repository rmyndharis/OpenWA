import { Controller, Put, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { SetProfileNameDto, SetProfileStatusDto, SetProfilePictureDto } from './dto/profile.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('profile')
@Controller('sessions/:sessionId/profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Put('name')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Set the account display name' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SetProfileNameDto })
  @ApiResponse({ status: 200, description: 'Profile name updated' })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 403, description: 'The engine refused the name change' })
  async setName(@Param('sessionId') sessionId: string, @Body() dto: SetProfileNameDto) {
    await this.profileService.setProfileName(sessionId, dto.name);
    return { success: true, message: 'Profile name updated' };
  }

  @Put('status')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Set the account about/status text' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SetProfileStatusDto })
  @ApiResponse({ status: 200, description: 'Profile status updated' })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  async setStatus(@Param('sessionId') sessionId: string, @Body() dto: SetProfileStatusDto) {
    await this.profileService.setProfileStatus(sessionId, dto.status);
    return { success: true, message: 'Profile status updated' };
  }

  @Put('picture')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Set the account profile picture (URL or base64 image)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({ type: SetProfilePictureDto })
  @ApiResponse({ status: 200, description: 'Profile picture updated' })
  @ApiResponse({
    status: 400,
    description: 'Neither url nor base64 provided, base64 without mimetype, or session is not started',
  })
  @ApiResponse({ status: 403, description: 'The engine refused the picture change' })
  @ApiResponse({ status: 413, description: 'Decoded base64 image exceeds the configured media cap' })
  async setPicture(@Param('sessionId') sessionId: string, @Body() dto: SetProfilePictureDto) {
    await this.profileService.setProfilePicture(sessionId, dto);
    return { success: true, message: 'Profile picture updated' };
  }
}
