export interface PlaceLocation {
  placeId?: string;
  name: string;
  formattedAddress?: string;
  lat?: number;
  lng?: number;
  googleMapsUrl: string;
  source?: 'gemini';
}

export type ActivityLocation = PlaceLocation;

export interface ActivityCost {
  ticket: number;
  food: number;
  transport: number;
  other: number;
  currency: string;
  source: 'gemini' | 'manual';
  confidence?: 'low' | 'medium' | 'high';
  note?: string;
  updatedAt?: string;
}

export interface Activity {
  id: string;
  time: string;
  title: string;
  description: string;
  type: 'food' | 'sightseeing' | 'relax' | 'transport';
  locationName?: string;
  long?: number;
  lat?: number;
  location: ActivityLocation;
  cost?: ActivityCost;
}

export interface DailyItinerary {
  dayNumber: number;
  date?: string;
  activities: Activity[];
}

export interface ItineraryResponse {
  destination: string;
  totalDays: number;
  durationDays?: number;
  startDate?: string;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  travelers?: number;
  theme: string[];
  destinationLocation?: PlaceLocation;
  days: DailyItinerary[];
  savedPlanId?: string;
}
