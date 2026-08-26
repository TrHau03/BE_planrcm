import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  ResponseSchema,
  SchemaType,
} from '@google/generative-ai';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../auth/auth-user.interface';
import { MapsService } from '../maps/maps.service';
import { ResolvedPlace } from '../maps/maps.types';
import { PlansService } from '../plans/plans.service';
import { GenerateItineraryDto } from './dto/generate-itinerary.dto';
import {
  Activity,
  DailyItinerary,
  ItineraryResponse,
} from '../shared/interfaces';

const JSON_SYSTEM_INSTRUCTION =
  'Bạn là hệ thống sinh lịch trình JSON. BẮT BUỘC chỉ trả về một chuỗi JSON hợp lệ theo cấu trúc ItineraryResponse, không có code block markdown (```json), không có text mở đầu hay kết thúc.';

const ACTIVITY_TYPES = ['food', 'sightseeing', 'relax', 'transport'] as const;

type GeneratedActivity = Omit<Activity, 'location'>;
type GeneratedDailyItinerary = Omit<DailyItinerary, 'activities'> & {
  activities: GeneratedActivity[];
};
type GeneratedItineraryResponse = Omit<ItineraryResponse, 'days'> & {
  days: GeneratedDailyItinerary[];
};

const ITINERARY_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    destination: { type: SchemaType.STRING },
    totalDays: { type: SchemaType.INTEGER },
    theme: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    days: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          dayNumber: { type: SchemaType.INTEGER },
          date: { type: SchemaType.STRING },
          activities: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                id: { type: SchemaType.STRING },
                time: { type: SchemaType.STRING },
                title: { type: SchemaType.STRING },
                description: { type: SchemaType.STRING },
                type: {
                  type: SchemaType.STRING,
                  format: 'enum',
                  enum: [...ACTIVITY_TYPES],
                },
                locationName: { type: SchemaType.STRING },
                long: { type: SchemaType.NUMBER },
                lat: { type: SchemaType.NUMBER },
              },
              required: [
                'id',
                'time',
                'title',
                'description',
                'type',
                'locationName',
              ],
            },
          },
        },
        required: ['dayNumber', 'activities'],
      },
    },
  },
  required: ['destination', 'totalDays', 'theme', 'days'],
};

@Injectable()
export class ItineraryService {
  constructor(
    private readonly config: ConfigService,
    private readonly plansService: PlansService,
    private readonly mapsService: MapsService,
  ) {}

  async generate(
    dto: GenerateItineraryDto,
    user?: AuthenticatedUser,
  ): Promise<ItineraryResponse> {
    if (
      dto.budgetMin !== undefined &&
      dto.budgetMax !== undefined &&
      dto.budgetMin > dto.budgetMax
    ) {
      throw new BadRequestException(
        'Ngân sách tối thiểu không được lớn hơn ngân sách tối đa.',
      );
    }
    if (dto.startDate && !isValidDateOnly(dto.startDate)) {
      throw new BadRequestException('Ngày khởi hành không hợp lệ.');
    }
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    const modelName =
      this.config.get<string>('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'GEMINI_API_KEY chưa được cấu hình. Hãy thêm khóa vào tệp .env của backend.',
      );
    }

    const selectedDestination = dto.destination
      ? dto.destinationPlaceId
        ? await this.mapsService.getPlaceDetails(
            dto.destinationPlaceId,
            undefined,
            dto.destination,
          )
        : await this.mapsService.searchText(dto.destination)
      : undefined;
    const currentLocation = dto.destination
      ? undefined
      : await this.mapsService.reverseGeocode(dto.lat, dto.lng);

    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      systemInstruction: JSON_SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ITINERARY_RESPONSE_SCHEMA,
        maxOutputTokens: 4096,
      },
    });

    let responseText: string;

    try {
      const result = await model.generateContent(
        this.createPrompt(dto, selectedDestination, currentLocation),
      );
      responseText = result.response.text();
    } catch {
      throw new ServiceUnavailableException(
        'Không thể kết nối Gemini. Hãy kiểm tra GEMINI_API_KEY và model đã cấu hình.',
      );
    }

    const parsedItinerary = this.parseItineraryResponse(
      responseText,
      dto.durationDays,
      dto.destination,
    );
    const itinerary = await this.mapsService.enrichItineraryLocations(
      parsedItinerary,
      selectedDestination,
    );
    const itineraryWithConstraints: ItineraryResponse = {
      ...this.applyStartDate(itinerary, dto.startDate),
      durationDays: dto.durationDays,
      ...(dto.budgetMin !== undefined ? { budgetMin: dto.budgetMin } : {}),
      ...(dto.budgetMax !== undefined ? { budgetMax: dto.budgetMax } : {}),
      ...(dto.currency ? { currency: dto.currency } : {}),
    };

    if (!user) {
      return itineraryWithConstraints;
    }

    const savedPlan = await this.plansService.save(
      user,
      itineraryWithConstraints,
    );

    return { ...itineraryWithConstraints, savedPlanId: savedPlan.id };
  }

  private createPrompt(
    {
      lat,
      lng,
      destination,
      packages = [],
      durationDays = 2,
      budgetMin,
      budgetMax,
      currency,
      startDate,
      locale = 'vi',
    }: GenerateItineraryDto,
    selectedDestination?: ResolvedPlace,
    currentLocation?: ResolvedPlace,
  ): string {
    const requestedPackages =
      packages.length > 0 ? packages.join(', ') : 'không có yêu cầu đặc biệt';
    const destinationLocationSource = 'Gemini đã ước lượng';
    const currentLocationSource = 'Gemini đã ước lượng';
    const destinationContext = destination
      ? [
          `Điểm đến người dùng đã chọn: ${destination}.`,
          `${destinationLocationSource} địa điểm này là "${selectedDestination?.formattedAddress ?? selectedDestination?.name ?? destination}" tại tọa độ ${selectedDestination?.lat ?? 'không xác định'},${selectedDestination?.lng ?? 'không xác định'}.`,
          `BẮT BUỘC lập lịch trình tại đúng ${destination}. Trường destination trong JSON phải là chính xác chuỗi "${destination}". Không tự đổi sang địa phương khác và không thêm chặng di chuyển từ một điểm xuất phát không được cung cấp.`,
        ].join(' ')
      : `Người dùng đang ở vị trí hiện tại được ${currentLocationSource} là "${currentLocation?.formattedAddress ?? `${lat},${lng}`}" (tọa độ ${currentLocation?.lat ?? lat},${currentLocation?.lng ?? lng}). Hãy gợi ý một lịch trình đi du lịch đến một thành phố hoặc địa phương phù hợp tính từ vị trí này.`;
    const budgetContext =
      budgetMin !== undefined || budgetMax !== undefined
        ? `Ngân sách mục tiêu: ${formatBudgetConstraint(budgetMin, budgetMax, currency)}. Đây là ràng buộc định hướng, không được hứa hẹn tổng chi phí chính xác. Chọn hoạt động, quán ăn, điểm tham quan và cách di chuyển phù hợp mức chi này.`
        : 'Không có ngân sách mục tiêu; hãy đề xuất mức chi tiêu hợp lý và nêu rõ đây là ước tính.';
    const departureContext = startDate
      ? `Ngày khởi hành: ${startDate}. Ngày 1 của lịch trình bắt đầu vào ngày này; hãy ưu tiên các hoạt động phù hợp với thứ trong tuần nếu có thông tin.`
      : 'Người dùng chưa chọn ngày khởi hành.';

    return [
      destinationContext,
      `Thời gian: ${durationDays} ngày. Yêu cầu đặc biệt (Packages): ${requestedPackages}. Hãy tính toán thời gian di chuyển hợp lý.`,
      departureContext,
      budgetContext,
      'Trả về đúng một JSON object theo ItineraryResponse với destination, totalDays, theme và days.',
      `totalDays phải bằng ${durationDays}; days phải có đúng ${durationDays} phần tử, được đánh số từ 1.`,
      'Mỗi activity phải có id dạng chuỗi riêng, time theo HH:mm, title, description, type là food/sightseeing/relax/transport và locationName. locationName phải là tên một địa điểm cụ thể kèm thành phố/tỉnh để Gemini đối chiếu, ví dụ "Bánh khọt Gốc Vú Sữa, Vũng Tàu"; tránh các mô tả chung chung như "trung tâm thành phố". Backend sẽ tự gán UUID, tọa độ, URL mở bản đồ và nguồn dữ liệu Gemini.',
      locale === 'en'
        ? 'Write every human-readable value in English. Do not add markdown or any text outside the JSON.'
        : 'Viết nội dung bằng tiếng Việt. Không thêm markdown hay bất kỳ văn bản nào ngoài JSON.',
    ].join('\n\n');
  }

  private parseItineraryResponse(
    responseText: string,
    expectedDays: number,
    expectedDestination?: string,
  ): ItineraryResponse {
    const cleanJson = responseText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    try {
      const parsed: unknown = JSON.parse(cleanJson);

      if (
        !isItineraryResponse(parsed) ||
        parsed.totalDays !== expectedDays ||
        parsed.days.length !== expectedDays ||
        parsed.days.some((day, index) => day.dayNumber !== index + 1) ||
        (expectedDestination !== undefined &&
          normalizeDestination(parsed.destination) !==
            normalizeDestination(expectedDestination))
      ) {
        throw new Error('Gemini response does not match ItineraryResponse.');
      }

      return this.normalizeActivities(parsed);
    } catch {
      throw new InternalServerErrorException(
        'Gemini đã trả về lịch trình không đúng định dạng JSON yêu cầu.',
      );
    }
  }

  /**
   * The backend owns UI identifiers and map URLs because model-generated
   * values can be invalid or not URL-encoded.
   */
  private normalizeActivities(
    itinerary: GeneratedItineraryResponse,
  ): ItineraryResponse {
    return {
      ...itinerary,
      days: itinerary.days.map((day) => ({
        ...day,
        activities: day.activities.map((activity) => ({
          ...activity,
          id: randomUUID(),
          location: {
            name: activity.locationName ?? activity.title,
            googleMapsUrl: createGoogleMapsUrl(
              activity.locationName ?? activity.title,
            ),
          },
        })),
      })),
    };
  }

  private applyStartDate(
    itinerary: ItineraryResponse,
    startDate?: string,
  ): ItineraryResponse {
    if (!startDate) {
      return itinerary;
    }

    return {
      ...itinerary,
      startDate,
      days: itinerary.days.map((day, index) => ({
        ...day,
        date: addDays(startDate, index),
      })),
    };
  }
}

function formatBudgetConstraint(
  min?: number,
  max?: number,
  currency?: string,
): string {
  const unit = currency ?? 'VND';
  if (min !== undefined && max !== undefined)
    return `${min.toLocaleString('vi-VN')} – ${max.toLocaleString('vi-VN')} ${unit}`;
  if (min !== undefined) return `từ ${min.toLocaleString('vi-VN')} ${unit}`;
  return `tối đa ${(max ?? 0).toLocaleString('vi-VN')} ${unit}`;
}

function isItineraryResponse(
  value: unknown,
): value is GeneratedItineraryResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.destination === 'string' &&
    typeof value.totalDays === 'number' &&
    Array.isArray(value.theme) &&
    value.theme.every((theme) => typeof theme === 'string') &&
    Array.isArray(value.days) &&
    value.days.every(isDailyItinerary)
  );
}

function isDailyItinerary(value: unknown): value is GeneratedDailyItinerary {
  return (
    isRecord(value) &&
    typeof value.dayNumber === 'number' &&
    (value.date === undefined || typeof value.date === 'string') &&
    Array.isArray(value.activities) &&
    value.activities.every(isActivity)
  );
}

function isActivity(value: unknown): value is GeneratedActivity {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.time === 'string' &&
    TIME_PATTERN.test(value.time) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.type === 'string' &&
    ACTIVITY_TYPES.includes(value.type as (typeof ACTIVITY_TYPES)[number]) &&
    typeof value.locationName === 'string' &&
    value.locationName.trim().length > 0 &&
    (value.long === undefined || typeof value.long === 'number') &&
    (value.lat === undefined || typeof value.lat === 'number')
  );
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function normalizeDestination(destination: string): string {
  return destination.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi-VN');
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function addDays(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function createGoogleMapsUrl(locationName: string): string {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', locationName);

  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
