import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { randomUUID } from 'node:crypto';
import { ItineraryResponse } from '../shared/interfaces';
import {
  ActivityCostEstimate,
  PlaceSuggestion,
  ResolvedPlace,
  RouteDistance,
  RouteMatrixDestination,
} from './maps.types';
import { EstimateCostsDto } from './dto/estimate-costs.dto';

type AiPlacesResponse = { places?: unknown[] };
type AiPlaceResponse = { place?: unknown };
type AiRouteResponse = { routes?: unknown[] };
type AiCostResponse = { estimates?: unknown[] };

const GEMINI_GEO_SYSTEM_INSTRUCTION =
  'Bạn là hệ thống địa điểm và ước lượng quãng đường cho ứng dụng lập lịch du lịch. Chỉ trả về JSON hợp lệ, không markdown hay văn bản ngoài JSON. Tọa độ, địa chỉ và quãng đường có thể là ước lượng; luôn trung thực về giới hạn này.';
const AI_PLACE_ID_PREFIX = 'gemini-';

/**
 * Gemini-only geographic context facade. The /maps REST routes are retained
 * for frontend compatibility but never call Google Maps Platform or use a
 * Google Maps API key.
 */
@Injectable()
export class MapsService {
  private readonly placeSearchCache = new Map<string, Promise<ResolvedPlace>>();
  private readonly placeCache = new Map<string, ResolvedPlace>();

  constructor(private readonly config: ConfigService) {}

  async autocomplete(
    input: string,
    sessionToken?: string,
  ): Promise<PlaceSuggestion[]> {
    void sessionToken;
    return this.withGemini(() => this.autocompleteWithGemini(input));
  }

  async getPlaceDetails(
    placeId: string,
    sessionToken?: string,
    fallbackText?: string,
  ): Promise<ResolvedPlace> {
    void sessionToken;
    const cachedPlace = this.placeCache.get(placeId);

    if (cachedPlace) {
      return cachedPlace;
    }

    return this.withGemini(() =>
      this.resolvePlaceWithGemini(fallbackText ?? 'Địa điểm đã chọn'),
    );
  }

  async searchText(textQuery: string): Promise<ResolvedPlace> {
    const cacheKey = textQuery.trim().toLocaleLowerCase('vi');
    const cached = this.placeSearchCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const request = this.withGemini(() =>
      this.resolvePlaceWithGemini(textQuery),
    );
    this.placeSearchCache.set(cacheKey, request);

    try {
      return await request;
    } catch (error) {
      this.placeSearchCache.delete(cacheKey);
      throw error;
    }
  }

  async reverseGeocode(lat: number, lng: number): Promise<ResolvedPlace> {
    return this.withGemini(() => this.reverseGeocodeWithGemini(lat, lng));
  }

  async computeRouteMatrix(
    origin: { lat: number; lng: number },
    destinations: RouteMatrixDestination[],
  ): Promise<RouteDistance[]> {
    if (destinations.length === 0) {
      return [];
    }

    return this.withGemini(() =>
      this.computeRouteMatrixWithGemini(origin, destinations),
    );
  }

  async estimateActivityCosts(
    dto: EstimateCostsDto,
  ): Promise<ActivityCostEstimate[]> {
    if (dto.activities.length === 0) {
      return [];
    }

    return this.withGemini(async () => {
      const response = await this.generateAiJson<AiCostResponse>(
        [
          'Ước tính chi phí du lịch hiện tại cho các hoạt động dưới đây.',
          `Điểm đến: ${JSON.stringify(dto.destination)}. Ngày khởi hành: ${dto.startDate ?? 'chưa xác định'}.`,
          `Số khách: ${dto.travelers}. Tiền tệ bắt buộc: ${dto.currency}.`,
          `Hoạt động: ${JSON.stringify(dto.activities)}.`,
          'Với mỗi id, trả ticket, food, transport, other là TỔNG chi phí cho toàn bộ số khách, không phải mỗi người.',
          'Dựa trên mức giá công khai thường gặp của địa điểm/khu vực và loại hoạt động. Nếu không có giá cụ thể, dùng khoảng giá địa phương hợp lý nhưng phải hạ confidence.',
          'Không hứa hẹn giá chính xác. note phải ngắn gọn, nói rõ giả định chính hoặc khoản nào cần kiểm tra lại.',
          'Trả đúng dạng {"estimates":[{"activityId":"...","ticket":number,"food":number,"transport":number,"other":number,"confidence":"low|medium|high","note":"..."}]}.',
          'Mọi chi phí phải là số không âm, làm tròn phù hợp với tiền tệ và trả đủ tất cả id.',
        ].join('\n'),
      );
      const requestedIds = new Set(
        dto.activities.map((activity) => activity.id),
      );
      const now = new Date().toISOString();

      return (response.estimates ?? []).flatMap((candidate) => {
        const record = asRecord(candidate);
        const activityId = asNonEmptyString(record?.activityId);
        const ticket = asNonNegativeNumber(record?.ticket);
        const food = asNonNegativeNumber(record?.food);
        const transport = asNonNegativeNumber(record?.transport);
        const other = asNonNegativeNumber(record?.other);
        const confidence = record?.confidence;

        if (
          !activityId ||
          !requestedIds.has(activityId) ||
          ticket === undefined ||
          food === undefined ||
          transport === undefined ||
          other === undefined ||
          !['low', 'medium', 'high'].includes(String(confidence))
        ) {
          return [];
        }

        return [
          {
            activityId,
            ticket,
            food,
            transport,
            other,
            currency: dto.currency.toUpperCase(),
            source: 'gemini' as const,
            confidence: confidence as 'low' | 'medium' | 'high',
            note:
              asNonEmptyString(record?.note) ??
              'Giá tham khảo, nên kiểm tra lại trước chuyến đi.',
            updatedAt: now,
          },
        ];
      });
    });
  }

  async enrichItineraryLocations(
    itinerary: ItineraryResponse,
    selectedDestination?: ResolvedPlace,
  ): Promise<ItineraryResponse> {
    const destinationLocation =
      selectedDestination ?? (await this.searchText(itinerary.destination));
    const activities = itinerary.days.flatMap((day) => day.activities);
    const resolvedLocations = await Promise.all(
      activities.map((activity) =>
        this.searchText(activity.locationName ?? activity.title),
      ),
    );
    const locations = new Map(
      activities.map((activity, index) => [
        activity.id,
        resolvedLocations[index],
      ]),
    );

    return {
      ...itinerary,
      destinationLocation,
      days: itinerary.days.map((day) => ({
        ...day,
        activities: day.activities.map((activity) => {
          const location = locations.get(activity.id);

          if (!location) {
            return activity;
          }

          return {
            ...activity,
            lat: location.lat,
            long: location.lng,
            location,
          };
        }),
      })),
    };
  }

  private async autocompleteWithGemini(
    input: string,
  ): Promise<PlaceSuggestion[]> {
    const response = await this.generateAiJson<AiPlacesResponse>(
      [
        'Hãy đề xuất tối đa 5 địa điểm phù hợp với truy vấn người dùng.',
        `Truy vấn: ${JSON.stringify(input)}`,
        'Trả về object đúng dạng {"places":[{"name":"...","formattedAddress":"...","lat":number,"lng":number}]}.',
        'Ưu tiên địa điểm thật, trả tọa độ thập phân gần đúng và địa chỉ bằng tiếng Việt khi phù hợp.',
      ].join('\n'),
    );
    const places = this.toPlaces(response.places, input, 5);

    if (places.length === 0) {
      throw new Error('Gemini did not return usable place suggestions.');
    }

    return places.map((place) => ({
      placeId: place.placeId!,
      text: place.formattedAddress ?? place.name,
      primaryText: place.name,
      ...(place.formattedAddress && place.formattedAddress !== place.name
        ? { secondaryText: place.formattedAddress }
        : {}),
      source: 'gemini',
    }));
  }

  private async resolvePlaceWithGemini(
    textQuery: string,
  ): Promise<ResolvedPlace> {
    const response = await this.generateAiJson<AiPlaceResponse>(
      [
        'Hãy xác định một địa điểm hoặc khu vực phù hợp với truy vấn.',
        `Truy vấn: ${JSON.stringify(textQuery)}`,
        'Trả về object đúng dạng {"place":{"name":"...","formattedAddress":"...","lat":number,"lng":number}}.',
        'Chỉ dùng tọa độ gần đúng cho một địa điểm có thật; không bịa ra độ chính xác.',
      ].join('\n'),
    );
    const place = this.toPlace(response.place, textQuery);
    this.placeCache.set(place.placeId!, place);

    return place;
  }

  private async reverseGeocodeWithGemini(
    lat: number,
    lng: number,
  ): Promise<ResolvedPlace> {
    const response = await this.generateAiJson<AiPlaceResponse>(
      [
        'Hãy nhận diện khu vực hoặc địa chỉ gần nhất từ tọa độ được cho.',
        `Tọa độ: ${lat}, ${lng}.`,
        'Trả về object đúng dạng {"place":{"name":"...","formattedAddress":"..."}}.',
        'Nếu không chắc địa chỉ chính xác, hãy dùng tên khu vực hoặc thành phố rộng hơn.',
      ].join('\n'),
    );
    const candidate = asRecord(response.place);

    if (!candidate) {
      throw new Error('Gemini did not return a usable reverse-geocoded place.');
    }

    const place = this.toPlace({ ...candidate, lat, lng }, `${lat}, ${lng}`);
    this.placeCache.set(place.placeId!, place);

    return place;
  }

  private async computeRouteMatrixWithGemini(
    origin: { lat: number; lng: number },
    destinations: RouteMatrixDestination[],
  ): Promise<RouteDistance[]> {
    const response = await this.generateAiJson<AiRouteResponse>(
      [
        'Ước lượng tuyến đường bộ cho từng điểm đến. Đây không phải chỉ đường thực tế.',
        `Điểm xuất phát: ${JSON.stringify(origin)}.`,
        `Điểm đến: ${JSON.stringify(destinations)}.`,
        'Trả về object đúng dạng {"routes":[{"id":"id tuong ung","distanceMeters":number,"durationSeconds":number}]}.',
        'Dùng quãng đường lái xe ước lượng, tất cả số phải dương và hãy trả đủ mọi id.',
      ].join('\n'),
    );
    const destinationIds = new Set(
      destinations.map((destination) => destination.id),
    );
    const routes = (response.routes ?? []).flatMap((candidate) => {
      const record = asRecord(candidate);
      const id = asNonEmptyString(record?.id);
      const distanceMeters = asPositiveNumber(record?.distanceMeters);
      const durationSeconds = asPositiveNumber(record?.durationSeconds);

      if (
        !id ||
        !destinationIds.has(id) ||
        !distanceMeters ||
        !durationSeconds
      ) {
        return [];
      }

      return [
        {
          id,
          distanceMeters: Math.round(distanceMeters),
          durationSeconds: Math.round(durationSeconds),
          source: 'gemini' as const,
        },
      ];
    });

    if (routes.length === 0) {
      throw new Error('Gemini did not return usable route estimates.');
    }

    return routes;
  }

  private toPlaces(
    candidates: unknown[] | undefined,
    query: string,
    limit: number,
  ): ResolvedPlace[] {
    const places: ResolvedPlace[] = [];

    for (const candidate of candidates ?? []) {
      if (places.length >= limit) {
        break;
      }

      try {
        const place = this.toPlace(candidate, query);
        this.placeCache.set(place.placeId!, place);
        places.push(place);
      } catch {
        // Keep valid Gemini suggestions even if one result is malformed.
      }
    }

    return places;
  }

  private toPlace(candidate: unknown, query: string): ResolvedPlace {
    const record = asRecord(candidate);
    const name = asNonEmptyString(record?.name) ?? query;
    const formattedAddress = asNonEmptyString(record?.formattedAddress) ?? name;
    const lat = asNumber(record?.lat);
    const lng = asNumber(record?.lng);

    if (!isLatitude(lat) || !isLongitude(lng)) {
      throw new Error('Gemini place coordinates are invalid.');
    }

    return {
      placeId: `${AI_PLACE_ID_PREFIX}${randomUUID()}`,
      name,
      formattedAddress,
      lat,
      lng,
      googleMapsUrl: createMapSearchUrl(formattedAddress),
      source: 'gemini',
    };
  }

  private async withGemini<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch {
      throw new ServiceUnavailableException(
        'Không thể lấy dữ liệu địa điểm từ Gemini. Hãy kiểm tra GEMINI_API_KEY và model đã cấu hình.',
      );
    }
  }

  private async generateAiJson<T>(prompt: string): Promise<T> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    const modelName =
      this.config.get<string>('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';

    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      systemInstruction: GEMINI_GEO_SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 4096,
      },
    });
    const result = await model.generateContent(prompt);

    return JSON.parse(stripJsonFences(result.response.text())) as T;
  }
}

function createMapSearchUrl(placeName: string): string {
  const query = new URLSearchParams({ api: '1', query: placeName });

  return `https://www.google.com/maps/search/?${query.toString()}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  const number = asNumber(value);

  return number !== undefined && number > 0 ? number : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const number = asNumber(value);

  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

function isLatitude(value: number | undefined): value is number {
  return value !== undefined && value >= -90 && value <= 90;
}

function isLongitude(value: number | undefined): value is number {
  return value !== undefined && value >= -180 && value <= 180;
}

function stripJsonFences(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}
