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
import { AuthenticatedRequest } from '../auth/auth-user.interface';
import { RequiredJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { PlansService } from './plans.service';

@Controller('market/plans')
@SkipThrottle()
export class MarketController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  findPublicPlans() {
    return this.plansService.findPublicPlans();
  }

  @Get(':planId')
  findPublicPlan(@Param('planId') planId: string) {
    return this.plansService.findPublicPlan(planId);
  }

  @Patch(':planId')
  @UseGuards(RequiredJwtAuthGuard)
  updatePublicPlan(
    @Param('planId') planId: string,
    @Body() dto: UpdatePlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.updatePublicItinerary(
      request.user!,
      planId,
      dto.itinerary,
    );
  }

  @Post(':planId/activities/:activityId/lock')
  @UseGuards(RequiredJwtAuthGuard)
  lockActivity(
    @Param('planId') planId: string,
    @Param('activityId') activityId: string,
    @Body() body: { sessionId?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.lockPublicActivity(
      request.user!,
      planId,
      activityId,
      body.sessionId,
    );
  }

  @Post(':planId/activities/:activityId/unlock')
  @UseGuards(RequiredJwtAuthGuard)
  unlockActivity(
    @Param('planId') planId: string,
    @Param('activityId') activityId: string,
    @Body() body: { sessionId?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.plansService.unlockPublicActivity(
      request.user!,
      planId,
      activityId,
      body.sessionId,
    );
  }
}
