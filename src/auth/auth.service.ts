import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CookieOptions } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthenticatedUser } from './auth-user.interface';
import { SESSION_MAX_AGE_MS } from './auth.constants';

type GoogleOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

type SessionPayload = Omit<AuthenticatedUser, 'id'> & {
  sub: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  isGoogleOAuthConfigured(): boolean {
    return Boolean(
      this.config.get<string>('GOOGLE_CLIENT_ID') &&
      this.config.get<string>('GOOGLE_CLIENT_SECRET') &&
      this.config.get<string>('GOOGLE_CALLBACK_URL') &&
      this.config.get<string>('JWT_SECRET'),
    );
  }

  createOAuthState(): string {
    return randomBytes(32).toString('base64url');
  }

  createGoogleAuthorizationUrl(state: string): string {
    const client = this.createGoogleClient();

    return client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
  }

  verifyOAuthState(expectedState: string | undefined, receivedState: unknown) {
    if (
      typeof receivedState !== 'string' ||
      !expectedState ||
      expectedState.length !== receivedState.length ||
      !timingSafeEqual(Buffer.from(expectedState), Buffer.from(receivedState))
    ) {
      throw new UnauthorizedException('Phiên đăng nhập Google không hợp lệ.');
    }
  }

  async authenticateGoogleCode(code: string): Promise<AuthenticatedUser> {
    const configuration = this.getGoogleOAuthConfiguration();
    const client = this.createGoogleClient(configuration);
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new UnauthorizedException(
        'Google không trả về thông tin đăng nhập.',
      );
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: configuration.clientId,
    });
    const profile = ticket.getPayload();

    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      throw new UnauthorizedException('Không thể xác minh tài khoản Google.');
    }

    return {
      id: profile.sub,
      email: profile.email,
      name: profile.name ?? profile.email,
      ...(profile.picture ? { avatarUrl: profile.picture } : {}),
    };
  }

  createSession(user: AuthenticatedUser): string {
    this.assertGoogleOAuthIsConfigured();

    return this.jwt.sign({
      sub: user.id,
      email: user.email,
      name: user.name,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    } satisfies SessionPayload);
  }

  async getSessionUser(
    token: string | undefined,
  ): Promise<AuthenticatedUser | null> {
    if (!token) {
      return null;
    }

    try {
      const payload = await this.jwt.verifyAsync<SessionPayload>(token);

      if (!payload.sub || !payload.email || !payload.name) {
        return null;
      }

      return {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        ...(payload.avatarUrl ? { avatarUrl: payload.avatarUrl } : {}),
      };
    } catch {
      return null;
    }
  }

  getSessionCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
      sameSite: this.isProduction() ? 'none' : 'lax',
      secure: this.isProduction(),
    };
  }

  getOAuthStateCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      maxAge: 10 * 60 * 1000,
      path: '/api/v1/auth',
      sameSite: 'lax',
      secure: this.config.get<string>('NODE_ENV') === 'production',
    };
  }

  private isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  getFrontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001'
    ).replace(/\/$/, '');
  }

  getFrontendRedirectUrl(returnTo: unknown): string {
    const path = this.getSafeReturnPath(returnTo);

    return `${this.getFrontendUrl()}${path}`;
  }

  getSafeReturnPath(value: unknown): string {
    return getSafeReturnPath(value);
  }

  private createGoogleClient(
    configuration = this.getGoogleOAuthConfiguration(),
  ): OAuth2Client {
    return new OAuth2Client(
      configuration.clientId,
      configuration.clientSecret,
      configuration.callbackUrl,
    );
  }

  private getGoogleOAuthConfiguration(): GoogleOAuthConfiguration {
    this.assertGoogleOAuthIsConfigured();

    return {
      clientId: this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackUrl: this.config.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
    };
  }

  private assertGoogleOAuthIsConfigured() {
    if (!this.isGoogleOAuthConfigured()) {
      throw new ServiceUnavailableException(
        'Đăng nhập Google chưa được cấu hình. Hãy thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL và JWT_SECRET vào .env của backend.',
      );
    }
  }
}

function getSafeReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return '/';
  }

  return value;
}
