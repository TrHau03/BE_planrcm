import { ConfigService } from '@nestjs/config';
import { MapsService } from './maps.service';

function createService() {
  return new MapsService({
    get: jest.fn(() => 'gemini-api-key'),
  } as unknown as ConfigService);
}

function mockGemini(service: MapsService, value: unknown) {
  const internal = service as unknown as { generateAiJson: jest.Mock };
  internal.generateAiJson = jest.fn().mockResolvedValue(value);

  return internal.generateAiJson;
}

describe('MapsService', () => {
  it('uses Gemini for place autocomplete without a Google Maps request', async () => {
    const service = createService();
    const generateAiJson = mockGemini(service, {
      places: [
        {
          name: 'Hồ Xuân Hương',
          formattedAddress: 'Đà Lạt, Lâm Đồng, Việt Nam',
          lat: 11.9416,
          lng: 108.4383,
        },
      ],
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    const suggestions = await service.autocomplete('Đà Lạt');

    expect(suggestions).toEqual([
      expect.objectContaining({
        text: 'Đà Lạt, Lâm Đồng, Việt Nam',
        primaryText: 'Hồ Xuân Hương',
        source: 'gemini',
      }),
    ]);
    expect(generateAiJson).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses Gemini for reverse geocoding while preserving the supplied coordinates', async () => {
    const service = createService();
    mockGemini(service, {
      place: {
        name: 'Quận 1',
        formattedAddress: 'Quận 1, Thành phố Hồ Chí Minh, Việt Nam',
      },
    });

    const place = await service.reverseGeocode(10.7769, 106.7009);

    expect(place).toMatchObject({
      name: 'Quận 1',
      lat: 10.7769,
      lng: 106.7009,
      source: 'gemini',
    });
  });

  it('uses Gemini route estimates for Market Plan ordering', async () => {
    const service = createService();
    const generateAiJson = mockGemini(service, {
      routes: [
        {
          id: 'public-plan-id',
          distanceMeters: 32000,
          durationSeconds: 3000,
        },
      ],
    });

    const distances = await service.computeRouteMatrix(
      { lat: 10.7769, lng: 106.7009 },
      [{ id: 'public-plan-id', lat: 10.8231, lng: 106.6297 }],
    );

    expect(distances).toEqual([
      {
        id: 'public-plan-id',
        distanceMeters: 32000,
        durationSeconds: 3000,
        source: 'gemini',
      },
    ]);
    expect(generateAiJson).toHaveBeenCalledTimes(1);
  });

  it('returns categorized trip costs for the full traveler group', async () => {
    const service = createService();
    mockGemini(service, {
      estimates: [
        {
          activityId: 'activity-1',
          ticket: 200000,
          food: 300000,
          transport: 50000,
          other: 0,
          confidence: 'medium',
          note: 'Giá tham khảo cho hai khách.',
        },
      ],
    });

    const estimates = await service.estimateActivityCosts({
      destination: 'Đà Lạt',
      currency: 'VND',
      travelers: 2,
      activities: [
        {
          id: 'activity-1',
          title: 'Tham quan',
          type: 'sightseeing',
          locationName: 'Đà Lạt',
        },
      ],
    });

    expect(estimates).toEqual([
      expect.objectContaining({
        activityId: 'activity-1',
        ticket: 200000,
        food: 300000,
        transport: 50000,
        other: 0,
        currency: 'VND',
        source: 'gemini',
        confidence: 'medium',
      }),
    ]);
  });
});
