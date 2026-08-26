import {
  HttpException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  App,
  applicationDefault,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { Firestore, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../auth/auth-user.interface';
import { MapsService } from '../maps/maps.service';
import { ItineraryResponse } from '../shared/interfaces';
import {
  PlanAuthor,
  PlanVisibility,
  PublicPlan,
  PublicPlanSummary,
  SavedPlan,
} from './plan.interface';

type StoredPlan = {
  userId: string;
  createdAt: Timestamp;
  visibility?: PlanVisibility;
  publishedAt?: Timestamp;
  clonedFromPlanId?: string;
  originalAuthorId?: string;
  itinerary: ItineraryResponse;
};

type StoredPublicPlan = {
  userId: string;
  createdAt: Timestamp;
  publishedAt: Timestamp;
  author: PlanAuthor;
  itinerary: ItineraryResponse;
};

const MARKET_PLANS_COLLECTION = 'marketPlans';
const MARKET_ACTIVITY_LOCKS_COLLECTION = 'marketPlanActivityLocks';

function isEditableItinerary(value: ItineraryResponse): boolean {
  return (
    typeof value.destination === 'string' &&
    value.destination.trim().length >= 2 &&
    Number.isInteger(value.totalDays) &&
    value.totalDays >= 1 &&
    value.totalDays <= 7 &&
    (value.startDate === undefined || isValidDateOnly(value.startDate)) &&
    (value.budgetMin === undefined ||
      (Number.isFinite(value.budgetMin) && value.budgetMin >= 0)) &&
    (value.budgetMax === undefined ||
      (Number.isFinite(value.budgetMax) && value.budgetMax >= 0)) &&
    (value.budgetMin === undefined ||
      value.budgetMax === undefined ||
      value.budgetMin <= value.budgetMax) &&
    Array.isArray(value.theme) &&
    Array.isArray(value.days) &&
    value.days.length === value.totalDays &&
    value.days.every(
      (day, index) =>
        day.dayNumber === index + 1 && Array.isArray(day.activities),
    )
  );
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

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private firestore: Firestore | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly mapsService: MapsService,
  ) {}

  async save(
    user: AuthenticatedUser,
    itinerary: ItineraryResponse,
  ): Promise<SavedPlan> {
    const plan: SavedPlan = {
      id: randomUUID(),
      userId: user.id,
      createdAt: new Date().toISOString(),
      visibility: 'private',
      itinerary,
    };

    try {
      await this.getFirestore()
        .collection('users')
        .doc(user.id)
        .collection('plans')
        .doc(plan.id)
        .set({
          userId: plan.userId,
          createdAt: Timestamp.fromDate(new Date(plan.createdAt)),
          visibility: plan.visibility,
          itinerary: plan.itinerary,
        } satisfies StoredPlan);

      return plan;
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async findByUserId(userId: string): Promise<SavedPlan[]> {
    try {
      const snapshot = await this.getFirestore()
        .collection('users')
        .doc(userId)
        .collection('plans')
        .orderBy('createdAt', 'desc')
        .get();

      return snapshot.docs.map((document) =>
        this.toSavedPlan(document.id, document.data() as StoredPlan),
      );
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async findOneForUser(userId: string, planId: string): Promise<SavedPlan> {
    try {
      const snapshot = await this.getFirestore()
        .collection('users')
        .doc(userId)
        .collection('plans')
        .doc(planId)
        .get();
      if (!snapshot.exists) {
        throw new NotFoundException('Không tìm thấy plan riêng của bạn.');
      }
      return this.toSavedPlan(planId, snapshot.data() as StoredPlan);
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async updateItinerary(
    user: AuthenticatedUser,
    planId: string,
    itinerary: ItineraryResponse,
  ): Promise<SavedPlan> {
    if (!isEditableItinerary(itinerary)) {
      throw new HttpException('Dữ liệu lịch trình không hợp lệ.', 400);
    }
    try {
      const firestore = this.getFirestore();
      const reference = firestore
        .collection('users')
        .doc(user.id)
        .collection('plans')
        .doc(planId);
      const snapshot = await reference.get();
      if (!snapshot.exists) {
        throw new NotFoundException('Không tìm thấy plan cần cập nhật.');
      }
      const storedPlan = snapshot.data() as StoredPlan;
      const batch = firestore.batch();
      batch.update(reference, { itinerary, updatedAt: Timestamp.now() });
      if (storedPlan.visibility === 'public') {
        batch.update(
          firestore.collection(MARKET_PLANS_COLLECTION).doc(planId),
          { itinerary },
        );
      }
      await batch.commit();
      return { ...this.toSavedPlan(planId, storedPlan), itinerary };
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async updatePublicItinerary(
    user: AuthenticatedUser,
    planId: string,
    itinerary: ItineraryResponse,
  ): Promise<PublicPlan> {
    if (!isEditableItinerary(itinerary))
      throw new HttpException('Dữ liệu lịch trình không hợp lệ.', 400);
    try {
      const firestore = this.getFirestore();
      const reference = firestore
        .collection(MARKET_PLANS_COLLECTION)
        .doc(planId);
      const snapshot = await reference.get();
      if (!snapshot.exists)
        throw new NotFoundException('Plan Market không còn tồn tại.');
      const source = snapshot.data() as StoredPublicPlan;
      this.assertPublicPlanOwner(user, source);
      const batch = firestore.batch();
      batch.update(reference, { itinerary });
      batch.update(
        firestore
          .collection('users')
          .doc(source.userId)
          .collection('plans')
          .doc(planId),
        { itinerary, updatedAt: Timestamp.now() },
      );
      await batch.commit();
      return {
        ...this.toPublicPlanSummary(planId, { ...source, itinerary }),
        itinerary,
      };
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async lockPublicActivity(
    user: AuthenticatedUser,
    planId: string,
    activityId: string,
    sessionId?: string,
  ) {
    if (!sessionId) throw new HttpException('Thiếu mã phiên chỉnh sửa.', 400);
    await this.assertOwnsPublicPlan(user, planId);
    const reference = this.getFirestore()
      .collection(MARKET_ACTIVITY_LOCKS_COLLECTION)
      .doc(`${planId}_${activityId}`);
    try {
      return await this.getFirestore().runTransaction(async (transaction) => {
        const current = await transaction.get(reference);
        const lock = current.data() as
          { userId: string; sessionId: string; userName: string } | undefined;
        if (lock && lock.userId !== user.id)
          throw new HttpException(
            `${lock.userName} đang chỉnh sửa hoạt động này.`,
            409,
          );
        transaction.set(reference, {
          planId,
          activityId,
          userId: user.id,
          userName: user.name,
          sessionId,
          lockedAt: Timestamp.now(),
        });
        return { locked: true, activityId };
      });
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async unlockPublicActivity(
    user: AuthenticatedUser,
    planId: string,
    activityId: string,
    sessionId?: string,
  ) {
    await this.assertOwnsPublicPlan(user, planId);
    const reference = this.getFirestore()
      .collection(MARKET_ACTIVITY_LOCKS_COLLECTION)
      .doc(`${planId}_${activityId}`);
    try {
      await this.getFirestore().runTransaction(async (transaction) => {
        const current = await transaction.get(reference);
        const lock = current.data() as
          { userId: string; sessionId: string } | undefined;
        if (
          lock &&
          lock.userId === user.id &&
          (!sessionId || lock.sessionId === sessionId)
        )
          transaction.delete(reference);
      });
      return { unlocked: true, activityId };
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async clone(
    user: AuthenticatedUser,
    sourcePlanId: string,
  ): Promise<SavedPlan> {
    try {
      const firestore = this.getFirestore();
      const ownReference = firestore
        .collection('users')
        .doc(user.id)
        .collection('plans')
        .doc(sourcePlanId);
      const ownSnapshot = await ownReference.get();
      let source: StoredPlan | StoredPublicPlan | undefined;
      let originalAuthorId: string | undefined;

      if (ownSnapshot.exists) {
        source = ownSnapshot.data() as StoredPlan;
        originalAuthorId = source.userId;
      } else {
        const publicSnapshot = await firestore
          .collection(MARKET_PLANS_COLLECTION)
          .doc(sourcePlanId)
          .get();
        if (!publicSnapshot.exists) {
          throw new NotFoundException(
            'Không tìm thấy plan để sao chép hoặc plan không còn được chia sẻ.',
          );
        }
        source = publicSnapshot.data() as StoredPublicPlan;
        originalAuthorId = source.userId;
      }

      const createdAt = new Date().toISOString();
      const clone: SavedPlan = {
        id: randomUUID(),
        userId: user.id,
        createdAt,
        visibility: 'private',
        clonedFromPlanId: sourcePlanId,
        ...(originalAuthorId ? { originalAuthorId } : {}),
        itinerary: structuredClone(source.itinerary),
      };
      await firestore
        .collection('users')
        .doc(user.id)
        .collection('plans')
        .doc(clone.id)
        .set({
          userId: clone.userId,
          createdAt: Timestamp.fromDate(new Date(createdAt)),
          visibility: clone.visibility,
          clonedFromPlanId: clone.clonedFromPlanId,
          ...(clone.originalAuthorId
            ? { originalAuthorId: clone.originalAuthorId }
            : {}),
          itinerary: clone.itinerary,
        } satisfies StoredPlan);

      return clone;
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async setVisibility(
    user: AuthenticatedUser,
    planId: string,
    visibility: PlanVisibility,
  ): Promise<SavedPlan> {
    try {
      const firestore = this.getFirestore();
      const planReference = firestore
        .collection('users')
        .doc(user.id)
        .collection('plans')
        .doc(planId);
      const snapshot = await planReference.get();

      if (!snapshot.exists) {
        throw new NotFoundException('Không tìm thấy lịch trình cần cập nhật.');
      }

      const storedPlan = snapshot.data() as StoredPlan;
      const itinerary =
        visibility === 'public'
          ? await this.mapsService.enrichItineraryLocations(
              storedPlan.itinerary,
            )
          : storedPlan.itinerary;
      const now = Timestamp.now();
      const batch = firestore.batch();

      batch.update(planReference, {
        visibility,
        ...(visibility === 'public' ? { publishedAt: now } : {}),
        ...(visibility === 'public' ? { itinerary } : {}),
      });

      const marketReference = firestore
        .collection(MARKET_PLANS_COLLECTION)
        .doc(planId);

      if (visibility === 'public') {
        batch.set(marketReference, {
          userId: user.id,
          createdAt: storedPlan.createdAt,
          publishedAt: now,
          author: this.toPlanAuthor(user),
          itinerary,
        } satisfies StoredPublicPlan);
      } else {
        batch.delete(marketReference);
      }

      await batch.commit();

      const savedPlan = this.toSavedPlan(planId, storedPlan);

      return {
        id: savedPlan.id,
        userId: savedPlan.userId,
        createdAt: savedPlan.createdAt,
        visibility,
        itinerary,
        ...(visibility === 'public'
          ? { publishedAt: now.toDate().toISOString() }
          : {}),
      };
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async findPublicPlans(): Promise<PublicPlanSummary[]> {
    try {
      const snapshot = await this.getFirestore()
        .collection(MARKET_PLANS_COLLECTION)
        .orderBy('publishedAt', 'desc')
        .limit(36)
        .get();

      return snapshot.docs.map((document) =>
        this.toPublicPlanSummary(
          document.id,
          document.data() as StoredPublicPlan,
        ),
      );
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  async findPublicPlan(planId: string): Promise<PublicPlan> {
    try {
      const snapshot = await this.getFirestore()
        .collection(MARKET_PLANS_COLLECTION)
        .doc(planId)
        .get();

      if (!snapshot.exists) {
        throw new NotFoundException(
          'Lịch trình này không còn được chia sẻ công khai.',
        );
      }

      const storedPlan = snapshot.data() as StoredPublicPlan;

      return {
        ...this.toPublicPlanSummary(planId, storedPlan),
        itinerary: storedPlan.itinerary,
      };
    } catch (error) {
      throw this.toFirestoreException(error);
    }
  }

  private getFirestore(): Firestore {
    if (this.firestore) {
      return this.firestore;
    }

    const projectId =
      this.config.get<string>('FIREBASE_PROJECT_ID') ??
      this.config.get<string>('GOOGLE_CLOUD_PROJECT');

    if (!projectId) {
      throw new ServiceUnavailableException(
        'Cloud Firestore chưa được cấu hình. Hãy thêm FIREBASE_PROJECT_ID và Google Application Default Credentials vào .env của backend.',
      );
    }

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialsPath && !existsSync(credentialsPath)) {
      // google-auth-library resolves this path with a synchronous fs.realpathSync
      // call that escapes the try/catch around every Firestore operation below
      // and crashes the whole process. Fail fast here instead.
      throw new ServiceUnavailableException(
        'Cloud Firestore chưa được cấu hình. Hãy kiểm tra GOOGLE_APPLICATION_CREDENTIALS trỏ đúng tới service-account JSON.',
      );
    }

    const app = this.getFirebaseApp(projectId);
    this.firestore = getFirestore(app);

    return this.firestore;
  }

  private async assertOwnsPublicPlan(user: AuthenticatedUser, planId: string) {
    const snapshot = await this.getFirestore()
      .collection(MARKET_PLANS_COLLECTION)
      .doc(planId)
      .get();

    if (!snapshot.exists) {
      throw new NotFoundException('Plan Market không còn tồn tại.');
    }

    this.assertPublicPlanOwner(user, snapshot.data() as StoredPublicPlan);
  }

  private assertPublicPlanOwner(
    user: AuthenticatedUser,
    plan: StoredPublicPlan,
  ) {
    if (plan.userId !== user.id) {
      throw new ForbiddenException(
        'Bạn không có quyền chỉnh sửa plan Market này.',
      );
    }
  }

  private getFirebaseApp(projectId: string): App {
    const appName = 'planrcm';
    const existingApp = getApps().find((app) => app.name === appName);

    return (
      existingApp ??
      initializeApp(
        {
          credential: applicationDefault(),
          projectId,
        },
        appName,
      )
    );
  }

  private toSavedPlan(id: string, plan: StoredPlan): SavedPlan {
    const visibility = plan.visibility ?? 'private';

    return {
      id,
      userId: plan.userId,
      createdAt: plan.createdAt.toDate().toISOString(),
      visibility,
      ...(visibility === 'public' && plan.publishedAt
        ? { publishedAt: plan.publishedAt.toDate().toISOString() }
        : {}),
      ...(plan.clonedFromPlanId
        ? { clonedFromPlanId: plan.clonedFromPlanId }
        : {}),
      ...(plan.originalAuthorId
        ? { originalAuthorId: plan.originalAuthorId }
        : {}),
      itinerary: plan.itinerary,
    };
  }

  private toPlanAuthor(user: AuthenticatedUser): PlanAuthor {
    return {
      name: user.name,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    };
  }

  private toPublicPlanSummary(
    id: string,
    plan: StoredPublicPlan,
  ): PublicPlanSummary {
    return {
      id,
      createdAt: plan.createdAt.toDate().toISOString(),
      publishedAt: plan.publishedAt.toDate().toISOString(),
      author: plan.author,
      destination: plan.itinerary.destination,
      ...(plan.itinerary.destinationLocation
        ? { destinationLocation: plan.itinerary.destinationLocation }
        : {}),
      totalDays: plan.itinerary.totalDays,
      theme: plan.itinerary.theme,
      ...(plan.itinerary.durationDays
        ? { durationDays: plan.itinerary.durationDays }
        : {}),
      ...(plan.itinerary.budgetMin !== undefined
        ? { budgetMin: plan.itinerary.budgetMin }
        : {}),
      ...(plan.itinerary.budgetMax !== undefined
        ? { budgetMax: plan.itinerary.budgetMax }
        : {}),
      ...(plan.itinerary.currency ? { currency: plan.itinerary.currency } : {}),
    };
  }

  private toFirestoreException(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    this.logger.error(
      'Cloud Firestore operation failed',
      error instanceof Error ? error.stack : error,
    );

    return new ServiceUnavailableException(
      'Không thể truy cập Cloud Firestore. Hãy kiểm tra FIREBASE_PROJECT_ID và Google Application Default Credentials.',
    );
  }
}
