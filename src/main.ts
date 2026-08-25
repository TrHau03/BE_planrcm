import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Express } from 'express';
import { AppModule } from './app.module';
// cookie-parser uses TypeScript's `export =` declaration; this import preserves
// its callable CommonJS shape under the Node runtime used by Nest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cookieParser = require('cookie-parser');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.set('trust proxy', 1);
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({
    credentials: true,
    origin: (config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim()),
  });

  await app.listen(Number(config.get<string>('PORT') ?? 3000), '0.0.0.0');
}
void bootstrap();
