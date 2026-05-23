import { NestFactory } from '@nestjs/core'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { ValidationPipe } from '@nestjs/common'
import helmet from 'helmet'
import * as express from 'express'
import { AppModule } from './app.module'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter'
import { HttpExceptionFilter } from './common/filters/http-exception.filter'
import { Logger } from './common/logger/logger.service'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const logger = app.get(Logger)

  // ========== SECURITY ==========
  app.use(helmet())
  app.use(express.json({ limit: '50mb' }))
  app.use(express.urlencoded({ limit: '50mb', extended: true }))

  // ========== CORS ==========
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  })

  // ========== GLOBAL PIPES ==========
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  )

  // ========== GLOBAL FILTERS ==========
  app.useGlobalFilters(new AllExceptionsFilter(logger), new HttpExceptionFilter(logger))

  // ========== API PREFIX ==========
  app.setGlobalPrefix(process.env.API_PREFIX || 'api')

  // ========== SWAGGER DOCS ==========
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Universal Music Hub X API')
      .setDescription('Enterprise-grade AI-native music streaming platform API')
      .setVersion(process.env.APP_VERSION || '0.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token',
        },
        'jwt',
      )
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API Key for external integrations',
        },
        'api-key',
      )
      .addServer('http://localhost:3001', 'Development')
      .addServer('https://api.music-hub.example.com', 'Production')
      .build()

    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    })
  }

  // ========== WEBSOCKET ==========
  const PORT = process.env.PORT || 3001
  const HOST = process.env.API_HOST || '0.0.0.0'

  await app.listen(PORT, HOST, () => {
    logger.log(`🚀 API Server running at http://${HOST}:${PORT}`)
    logger.log(`📚 API Docs at http://${HOST}:${PORT}/api/docs`)
    logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
  })
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application:', err)
  process.exit(1)
})
