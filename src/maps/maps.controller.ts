import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PlaceAutocompleteQueryDto } from './dto/place-autocomplete-query.dto';
import { PlaceDetailsQueryDto } from './dto/place-details-query.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { RouteMatrixDto } from './dto/route-matrix.dto';
import { EstimateCostsDto } from './dto/estimate-costs.dto';
import { MapsService } from './maps.service';

@Controller('maps')
@Throttle({ default: { limit: 24, ttl: 60_000 } })
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Get('places/autocomplete')
  autocomplete(@Query() query: PlaceAutocompleteQueryDto) {
    return this.mapsService.autocomplete(query.input, query.sessionToken);
  }

  @Get('places/:placeId')
  placeDetails(
    @Param('placeId') placeId: string,
    @Query() query: PlaceDetailsQueryDto,
  ) {
    return this.mapsService.getPlaceDetails(
      placeId,
      query.sessionToken,
      query.fallbackText,
    );
  }

  @Get('reverse-geocode')
  reverseGeocode(@Query() query: ReverseGeocodeQueryDto) {
    return this.mapsService.reverseGeocode(query.lat, query.lng);
  }

  @Post('routes/matrix')
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  routeMatrix(@Body() dto: RouteMatrixDto) {
    return this.mapsService.computeRouteMatrix(dto.origin, dto.destinations);
  }

  @Post('costs/estimate')
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  estimateCosts(@Body() dto: EstimateCostsDto) {
    return this.mapsService.estimateActivityCosts(dto);
  }
}
