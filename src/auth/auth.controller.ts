import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { AuthenticatedRequest } from './auth-user.interface';
import {
  AUTH_SESSION_COOKIE,
  GOOGLE_OAUTH_RETURN_TO_COOKIE,
  GOOGLE_OAUTH_STATE_COOKIE,
} from './auth.constants';
import { AuthService } from './auth.service';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

@Controller('auth')
@SkipThrottle()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('google')
  beginGoogleLogin(
    @Query('returnTo') returnTo: unknown,
    @Res() response: Response,
  ) {
    const state = this.authService.createOAuthState();

    response.cookie(
      GOOGLE_OAUTH_STATE_COOKIE,
      state,
      this.authService.getOAuthStateCookieOptions(),
    );
    response.cookie(
      GOOGLE_OAUTH_RETURN_TO_COOKIE,
      this.authService.getSafeReturnPath(returnTo),
      this.authService.getOAuthStateCookieOptions(),
    );
    response.redirect(this.authService.createGoogleAuthorizationUrl(state));
  }

  @Get('google/callback')
  async finishGoogleLogin(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    try {
      this.authService.verifyOAuthState(
        request.cookies?.[GOOGLE_OAUTH_STATE_COOKIE] as string | undefined,
        state,
      );

      if (typeof code !== 'string') {
        throw new Error('Missing Google OAuth authorization code.');
      }

      const user = await this.authService.authenticateGoogleCode(code);
      const session = this.authService.createSession(user);

      response.clearCookie(
        GOOGLE_OAUTH_STATE_COOKIE,
        this.authService.getOAuthStateCookieOptions(),
      );
      const returnTo = request.cookies?.[GOOGLE_OAUTH_RETURN_TO_COOKIE] as
        | string
        | undefined;
      response.clearCookie(
        GOOGLE_OAUTH_RETURN_TO_COOKIE,
        this.authService.getOAuthStateCookieOptions(),
      );
      response.cookie(
        AUTH_SESSION_COOKIE,
        session,
        this.authService.getSessionCookieOptions(),
      );
      response.redirect(
        `${this.authService.getFrontendRedirectUrl(returnTo)}${
          typeof returnTo === 'string' && returnTo.includes('?') ? '&' : '?'
        }auth=success`,
      );
    } catch (error) {
      console.error('Google OAuth login failed.', error);
      response.clearCookie(
        GOOGLE_OAUTH_STATE_COOKIE,
        this.authService.getOAuthStateCookieOptions(),
      );
      response.clearCookie(
        GOOGLE_OAUTH_RETURN_TO_COOKIE,
        this.authService.getOAuthStateCookieOptions(),
      );
      response.redirect(`${this.authService.getFrontendUrl()}/?auth=failed`);
    }
  }

  @Get('me')
  @UseGuards(OptionalJwtAuthGuard)
  currentUser(@Req() request: AuthenticatedRequest) {
    return {
      user: request.user ?? null,
      googleOAuthEnabled: this.authService.isGoogleOAuthConfigured(),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res() response: Response) {
    response.clearCookie(
      AUTH_SESSION_COOKIE,
      this.authService.getSessionCookieOptions(),
    );
    response.status(HttpStatus.NO_CONTENT).send();
  }
}
