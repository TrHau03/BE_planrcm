import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RequiredJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { AuthenticatedRequest } from '../auth/auth-user.interface';
import { UpdatePlanVisibilityDto } from './dto/update-plan-visibility.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { PlansService } from './plans.service';

@Controller('plans')
@SkipThrottle()
@UseGuards(RequiredJwtAuthGuard)
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  findMine(@Req() request: AuthenticatedRequest) {
    return this.plansService.findByUserId(request.user!.id);
  }

  @Post(':planId/clone')
  clone(@Param('planId') planId: string, @Req() request: AuthenticatedRequest) {
    return this.plansService.clone(request.user!, planId);
  }

  @Get(':planId')
  findOne(
    @Param('planId') planId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.findOneForUser(request.user!.id, planId);
  }

  @Patch(':planId')
  update(
    @Param('planId') planId: string,
    @Body() dto: UpdatePlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.updateItinerary(
      request.user!,
      planId,
      dto.itinerary,
    );
  }

  @Patch(':planId/visibility')
  updateVisibility(
    @Param('planId') planId: string,
    @Body() dto: UpdatePlanVisibilityDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.setVisibility(
      request.user!,
      planId,
      dto.isPublic ? 'public' : 'private',
    );
  }
}
