import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CostEstimateActivityDto {
  @IsString()
  @MaxLength(100)
  id: string;

  @IsString()
  @MaxLength(160)
  title: string;

  @IsIn(['food', 'sightseeing', 'relax', 'transport'])
  type: 'food' | 'sightseeing' | 'relax' | 'transport';

  @IsString()
  @MaxLength(240)
  locationName: string;
}

export class EstimateCostsDto {
  @IsString()
  @MaxLength(160)
  destination: string;

  @IsString()
  @MaxLength(3)
  currency: string;

  @IsInt()
  @Min(1)
  @Max(50)
  travelers: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  startDate?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CostEstimateActivityDto)
  activities: CostEstimateActivityDto[];
}
