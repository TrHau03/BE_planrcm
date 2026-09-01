import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/auth-user.interface';
import { MapsService } from '../maps/maps.service';
import { ItineraryResponse } from '../shared/interfaces';
import { PlansService } from './plans.service';

const user: AuthenticatedUser = {
  id: 'google-user-id',
  email: 'private@example.com',
  name: 'Nguyễn An',
  avatarUrl: 'https://example.com/avatar.jpg',
};

const itinerary: ItineraryResponse = {
  destination: 'Đà Lạt, Lâm Đồng',
  totalDays: 2,
  theme: ['foodie', 'relax'],
  days: [],
};

function timestamp(value: string) {
  return Timestamp.fromDate(new Date(value));
}

function mapsServiceMock() {
  return {
    enrichItineraryLocations: jest.fn((value: ItineraryResponse) =>
      Promise.resolve(value),
    ),
  } as unknown as MapsService;
}

describe('PlansService', () => {
  it('creates a public copy without the account email when a plan is shared', async () => {
    const createdAt = timestamp('2026-08-01T08:00:00.000Z');
    const planReference = {
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({
          userId: user.id,
          createdAt,
          itinerary,
          visibility: 'private',
        }),
      }),
    };
    const marketReference = { id: 'plan-id' };
    const setPublicCopy = jest.fn<void, [unknown, unknown]>();
    const batch = {
      update: jest.fn(),
      set: setPublicCopy,
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    const firestore = {
      collection: jest.fn((collectionName: string) => {
        if (collectionName === 'users') {
          return {
            doc: jest.fn(() => ({
              collection: jest.fn(() => ({
                doc: jest.fn(() => planReference),
              })),
            })),
          };
        }

        return { doc: jest.fn(() => marketReference) };
      }),
      batch: jest.fn(() => batch),
    } as unknown as Firestore;
    const mapsService = mapsServiceMock();
    const service = new PlansService({} as ConfigService, mapsService);
    (service as unknown as { firestore: Firestore }).firestore = firestore;

    const result = await service.setVisibility(user, 'plan-id', 'public');

    expect(result).toMatchObject({
      id: 'plan-id',
      visibility: 'public',
      itinerary,
    });
    expect(setPublicCopy).toHaveBeenCalledWith(
      marketReference,
      expect.objectContaining({
        userId: user.id,
        author: { name: user.name, avatarUrl: user.avatarUrl },
        itinerary,
      }),
    );
    expect(setPublicCopy.mock.calls[0]?.[1]).not.toHaveProperty('email');
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('removes only the public copy when a plan is made private', async () => {
    const planReference = {
      get: jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({
          userId: user.id,
          createdAt: timestamp('2026-08-01T08:00:00.000Z'),
          itinerary,
          visibility: 'public',
          publishedAt: timestamp('2026-08-02T08:00:00.000Z'),
        }),
      }),
    };
    const marketReference = { id: 'plan-id' };
    const batch = {
      update: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    const firestore = {
      collection: jest.fn((collectionName: string) => {
        if (collectionName === 'users') {
          return {
            doc: jest.fn(() => ({
              collection: jest.fn(() => ({
                doc: jest.fn(() => planReference),
              })),
            })),
          };
        }

        return { doc: jest.fn(() => marketReference) };
      }),
      batch: jest.fn(() => batch),
    } as unknown as Firestore;
    const service = new PlansService({} as ConfigService, mapsServiceMock());
    (service as unknown as { firestore: Firestore }).firestore = firestore;

    const result = await service.setVisibility(user, 'plan-id', 'private');

    expect(result).toMatchObject({ visibility: 'private', itinerary });
    expect(result).not.toHaveProperty('publishedAt');
    expect(batch.delete).toHaveBeenCalledWith(marketReference);
    expect(batch.set).not.toHaveBeenCalled();
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('does not expose an itinerary in the public feed payload', async () => {
    const firestore = {
      collection: jest.fn(() => ({
        orderBy: jest.fn(() => ({
          limit: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({
              docs: [
                {
                  id: 'plan-id',
                  data: () => ({
                    userId: user.id,
                    createdAt: timestamp('2026-08-01T08:00:00.000Z'),
                    publishedAt: timestamp('2026-08-02T08:00:00.000Z'),
                    author: { name: user.name },
                    itinerary,
                  }),
                },
              ],
            }),
          })),
        })),
      })),
    } as unknown as Firestore;
    const service = new PlansService({} as ConfigService, mapsServiceMock());
    (service as unknown as { firestore: Firestore }).firestore = firestore;

    const [result] = await service.findPublicPlans();

    expect(result).toMatchObject({
      id: 'plan-id',
      author: { name: user.name },
      destination: itinerary.destination,
    });
    expect(result).not.toHaveProperty('itinerary');
  });

  it('returns 404 for a public plan that has been unshared', async () => {
    const firestore = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({ exists: false }),
        })),
      })),
    } as unknown as Firestore;
    const service = new PlansService({} as ConfigService, mapsServiceMock());
    (service as unknown as { firestore: Firestore }).firestore = firestore;

    await expect(service.findPublicPlan('missing-plan')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('clones an owned plan into a new private plan without changing its source', async () => {
    const sourcePlan = {
      userId: user.id,
      createdAt: timestamp('2026-08-01T08:00:00.000Z'),
      visibility: 'public' as const,
      itinerary,
    };
    const sourceReference = {
      get: jest
        .fn()
        .mockResolvedValue({ exists: true, data: () => sourcePlan }),
    };
    const clonedReference = { set: jest.fn().mockResolvedValue(undefined) };
    const plansCollection = {
      doc: jest.fn((id: string) =>
        id === 'source-plan' ? sourceReference : clonedReference,
      ),
    };
    const firestore = {
      collection: jest.fn((name: string) => {
        if (name === 'users') {
          return {
            doc: jest.fn(() => ({
              collection: jest.fn(() => plansCollection),
            })),
          };
        }
        return { doc: jest.fn() };
      }),
    } as unknown as Firestore;
    const service = new PlansService({} as ConfigService, mapsServiceMock());
    (service as unknown as { firestore: Firestore }).firestore = firestore;

    const clone = await service.clone(user, 'source-plan');

    expect(clone).toMatchObject({
      userId: user.id,
      visibility: 'private',
      clonedFromPlanId: 'source-plan',
      originalAuthorId: user.id,
      itinerary,
    });
    expect(clone.id).not.toBe('source-plan');
    expect(clonedReference.set).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'private',
        clonedFromPlanId: 'source-plan',
        itinerary,
      }),
    );
    expect(sourceReference.get).toHaveBeenCalledTimes(1);
  });
});
