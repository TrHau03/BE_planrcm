import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { PlansService } from '../plans/plans.service';
import { MapsService } from '../maps/maps.service';
import { ItineraryService } from './itinerary.service';

describe('ItineraryService', () => {
  const service = new ItineraryService(
    {
      get: jest.fn(),
    } as unknown as ConfigService,
    {} as PlansService,
    {} as MapsService,
  );

  it('parses a Gemini response wrapped in a JSON markdown fence', () => {
    const parsed = (
      service as unknown as {
        parseItineraryResponse: (
          value: string,
          expectedDays: number,
        ) => unknown;
      }
    ).parseItineraryResponse(
      `\`\`\`json
      {"destination":"Đà Nẵng","totalDays":1,"theme":["foodie"],"days":[{"dayNumber":1,"activities":[{"id":"dfa7d5d1-1f83-4e45-bd7c-9d6c28318ce7","time":"08:30","title":"Ăn sáng","description":"Mì Quảng","type":"food","locationName":"Đà Nẵng","lat":16.0544,"long":108.2022}]}]}
      \`\`\``,
      1,
    );

    expect(parsed).toMatchObject({
      destination: 'Đà Nẵng',
      totalDays: 1,
      theme: ['foodie'],
      days: [
        {
          activities: [
            {
              location: {
                name: 'Đà Nẵng',
              },
            },
          ],
        },
      ],
    });
  });

  it('rejects valid JSON that does not satisfy the response contract', () => {
    expect(() =>
      (
        service as unknown as {
          parseItineraryResponse: (
            value: string,
            expectedDays: number,
          ) => unknown;
        }
      ).parseItineraryResponse('{"destination":"Đà Nẵng"}', 2),
    ).toThrow(InternalServerErrorException);
  });

  it('replaces a Gemini activity ID with a valid server-side UUID', () => {
    const parsed = (
      service as unknown as {
        parseItineraryResponse: (
          value: string,
          expectedDays: number,
        ) => { days: Array<{ activities: Array<{ id: string }> }> };
      }
    ).parseItineraryResponse(
      '{"destination":"Đà Nẵng","totalDays":1,"theme":[],"days":[{"dayNumber":1,"activities":[{"id":"not-a-uuid","time":"08:30","title":"Ăn sáng","description":"Mì Quảng","type":"food","locationName":"Mì Quảng Bà Mua"}]}]}',
      1,
    );

    expect(parsed.days[0].activities[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('creates a plain map search URL from the place without calling a Maps API', () => {
    const parsed = (
      service as unknown as {
        parseItineraryResponse: (
          value: string,
          expectedDays: number,
        ) => {
          days: Array<{
            activities: Array<{ location: { googleMapsUrl: string } }>;
          }>;
        };
      }
    ).parseItineraryResponse(
      '{"destination":"Đà Nẵng","totalDays":1,"theme":[],"days":[{"dayNumber":1,"activities":[{"id":"any-id","time":"08:30","title":"Ăn sáng","description":"Mì Quảng","type":"food","locationName":"Mì Quảng Bà Mua"}]}]}',
      1,
    );
    const mapUrl = new URL(parsed.days[0].activities[0].location.googleMapsUrl);

    expect(mapUrl.origin).toBe('https://www.google.com');
    expect(mapUrl.pathname).toBe('/maps/search/');
    expect(mapUrl.searchParams.get('api')).toBe('1');
    expect(mapUrl.searchParams.get('query')).toBe('Mì Quảng Bà Mua');
  });

  it('keeps a user-selected destination unchanged', () => {
    const parseItineraryResponse = (
      value: string,
      expectedDays: number,
      expectedDestination?: string,
    ) =>
      (
        service as unknown as {
          parseItineraryResponse: (
            value: string,
            expectedDays: number,
            expectedDestination?: string,
          ) => unknown;
        }
      ).parseItineraryResponse(value, expectedDays, expectedDestination);
    const response =
      '{"destination":"Đà Lạt, Lâm Đồng","totalDays":1,"theme":[],"days":[{"dayNumber":1,"activities":[{"id":"any-id","time":"08:30","title":"Ăn sáng","description":"Bắt đầu ngày mới.","type":"food","locationName":"Chợ Đà Lạt, Lâm Đồng"}]}]}';

    expect(() =>
      parseItineraryResponse(response, 1, 'Đà Lạt, Lâm Đồng'),
    ).not.toThrow();
    expect(() => parseItineraryResponse(response, 1, 'Nha Trang')).toThrow(
      InternalServerErrorException,
    );
  });

  it('anchors every itinerary day to the selected departure date', () => {
    const dated = (
      service as unknown as {
        applyStartDate: (
          itinerary: {
            destination: string;
            totalDays: number;
            theme: string[];
            days: Array<{ dayNumber: number; activities: unknown[] }>;
          },
          startDate?: string,
        ) => { startDate?: string; days: Array<{ date?: string }> };
      }
    ).applyStartDate(
      {
        destination: 'Đà Lạt',
        totalDays: 3,
        theme: [],
        days: [
          { dayNumber: 1, activities: [] },
          { dayNumber: 2, activities: [] },
          { dayNumber: 3, activities: [] },
        ],
      },
      '2026-12-30',
    );

    expect(dated.startDate).toBe('2026-12-30');
    expect(dated.days.map((day) => day.date)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
  });
});
