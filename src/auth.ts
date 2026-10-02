import type { NextFunction, Request, Response } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from './config.js';

export interface AuthedUser {
  uid: string;
  email?: string;
}

export type TokenVerifier = (token: string) => Promise<AuthedUser>;

// Valida el ID token de Firebase del usuario (solo requiere el projectId, sin credenciales)
export const verifyFirebaseToken: TokenVerifier = async (token) => {
  if (getApps().length === 0) initializeApp({ projectId: config.firebaseProjectId });
  const decoded = await getAuth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
};

export function requireAuth(verify: TokenVerifier) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: 'Falta el token de sesión.' });
      return;
    }
    try {
      res.locals['user'] = await verify(token);
      next();
    } catch {
      res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
  };
}
