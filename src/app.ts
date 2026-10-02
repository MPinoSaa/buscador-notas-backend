import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, type TokenVerifier } from './auth.js';
import { config } from './config.js';
import type { ExamplesStore } from './examples.js';
import type { Restructurer } from './restructure.js';
import { notasRouter } from './routes/notas.js';

export interface AppDeps {
  verifyToken: TokenVerifier;
  restructure: Restructurer;
  examples: ExamplesStore;
}

export function createApp({ verifyToken, restructure, examples }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Cada llamada a la IA cuesta: máximo 10 por minuto por IP
  const aiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Espera un minuto.' }
  });

  app.use('/api/notas', requireAuth(verifyToken), aiLimiter, notasRouter(restructure, examples));

  return app;
}
