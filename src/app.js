import express from 'express';
import cors from 'cors';
import { pool } from './config/db.js';
import referenceRouter from './routes/reference.js';
import authRouter from './routes/auth.js';
import onboardingRouter from './routes/onboarding.js';
import profileRouter from './routes/profile.js';
import eventsRouter from './routes/events.js';

export function createApp() {
  const app = express();

  app.use(cors(
    {
      origin: ["http://localhost:5173", "http://localhost:5174"],
      credentials: true,
    }
  ));
  app.use(express.json());

  app.use('/reference', referenceRouter);
  app.use('/auth', authRouter);
  app.use('/onboarding', onboardingRouter);
  app.use('/profile', profileRouter);
  app.use('/events', eventsRouter);

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

  // Error handler
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}
