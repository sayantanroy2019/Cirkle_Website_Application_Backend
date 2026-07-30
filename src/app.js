import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger.js';
import { pool } from './config/db.js';
import referenceRouter from './routes/reference.js';
import authRouter from './routes/auth.js';
import onboardingRouter from './routes/onboarding.js';
import profileRouter from './routes/profile.js';
import eventsRouter from './routes/events.js';
import ordersRouter from './routes/orders.js';
import webhookRouter from './routes/webhook.js';
import ticketsRouter from './routes/tickets.js';
import couponsRouter from './routes/coupons.js';
import vibesRouter from './routes/vibes.js';
import uploadsRouter from './routes/uploads.js';
import errorHandler from './middlewares/errorHandler.js';

export function createApp() {
  const app = express();

  app.use(cors(
    {
      origin: [
        "http://localhost:5173",
        "http://localhost:5174",
        "https://cirkle-website-application-frontend.vercel.app"
      ],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
    }
  ));
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Swagger UI — API documentation
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  app.use('/reference', referenceRouter);
  app.use('/auth', authRouter);
  app.use('/onboarding', onboardingRouter);
  app.use('/profile', profileRouter);
  app.use('/events', eventsRouter);
  app.use('/payments',ordersRouter);
  app.use('/webhooks',webhookRouter);
  app.use('/tickets', ticketsRouter);
  app.use('/coupons', couponsRouter);
  app.use('/vibes', vibesRouter);
  app.use('/uploads', uploadsRouter);


  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'cirkle-backend' });
  });

  app.get('/health/db', async (req, res) => {
    try {
      const result = await pool.query('SELECT NOW() AS now');
      res.json({ status: 'ok', now: result.rows[0].now });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // API routes will be mounted here, e.g. app.use('/api/events', eventsRouter)

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler — must be last
  app.use(errorHandler);

  return app;
}
