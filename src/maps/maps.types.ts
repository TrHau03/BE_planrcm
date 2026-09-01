import { PlaceLocation } from '../shared/interfaces';

export type LocationDataSource = 'gemini';

export interface PlaceSuggestion {
  placeId: string;
  text: string;
  primaryText?: string;
  secondaryText?: string;
  source: LocationDataSource;
}

export type ResolvedPlace = Required<
  Pick<PlaceLocation, 'name' | 'lat' | 'lng' | 'googleMapsUrl' | 'source'>
> &
  Omit<PlaceLocation, 'name' | 'lat' | 'lng' | 'googleMapsUrl' | 'source'>;

export interface RouteMatrixDestination {
  id: string;
  lat: number;
  lng: number;
}

export interface RouteDistance {
  id: string;
  distanceMeters: number;
  durationSeconds: number;
  source: LocationDataSource;
}

export interface ActivityCostEstimate {
  activityId: string;
  ticket: number;
  food: number;
  transport: number;
  other: number;
  currency: string;
  source: 'gemini';
  confidence: 'low' | 'medium' | 'high';
  note: string;
  updatedAt: string;
}
