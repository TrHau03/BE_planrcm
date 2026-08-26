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
  theme: string[];
  destinationLocation?: PlaceLocation;
  days: DailyItinerary[];
  savedPlanId?: string;
}
