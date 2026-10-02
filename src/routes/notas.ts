import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { selectExamples, type ExamplesStore } from '../examples.js';
import { createRedactor } from '../redact.js';
import { RestructureError, type Restructurer } from '../restructure.js';

const bodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  tag: z.string().trim().max(60).default('OTROS'),
  content: z.string().trim().min(1).max(config.maxContentChars)
});

const exampleSchema = z.object({
  title: z.string().trim().min(1).max(300),
  tag: z.string().trim().min(1).max(60),
  original: z.string().trim().min(1).max(config.maxContentChars),
  final: z.string().trim().min(1).max(config.maxContentChars)
});

// Oculta datos sensibles de un ejemplo (mismo marcador para el mismo valor en original y final)
function redactExample<T extends { title: string; original: string; final: string }>(example: T): T {
  const redactor = createRedactor('EJ');
  return {
    ...example,
    title: redactor.redact(example.title),
    original: redactor.redact(example.original),
    final: redactor.redact(example.final)
  };
}

export function notasRouter(restructure: Restructurer, examples: ExamplesStore) {
  const router = Router();

  // Reestructura el contenido de una nota; no guarda nada, solo devuelve la propuesta
  router.post('/reestructurar', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: `Datos inválidos. El contenido es obligatorio y admite hasta ${config.maxContentChars} caracteres.`
      });
      return;
    }
    try {
      // Ejemplos aprobados antes por el equipo; si no se pueden leer, se sigue sin ellos
      const selected = selectExamples(await examples.list().catch(() => []), parsed.data.tag).map(redactExample);

      // La IA nunca ve contraseñas, tokens ni IPs reales: se cambian por marcadores y se restauran después
      const redactor = createRedactor();
      const output = await restructure({
        ...parsed.data,
        title: redactor.redact(parsed.data.title),
        content: redactor.redact(parsed.data.content),
        examples: selected
      });

      let content = redactor.restore(output);
      // Si la IA omitió algún dato sensible, se avisa en la propuesta para no perderlo al guardar
      const missing = redactor.missingFrom(output);
      if (missing.length > 0) {
        content += `\n\n[REVISAR: la IA omitió estos datos de la nota original, agrégalos donde corresponda: ${missing.join(', ')}]`;
      }
      res.json({ content, redacted: redactor.count });
    } catch (error) {
      const status = error instanceof RestructureError ? error.status : 500;
      res.status(status).json({ error: error instanceof Error ? error.message : 'Error interno.' });
    }
  });

  // Guarda un par "original -> resultado aprobado" para que la IA aprenda el estilo del equipo
  router.post('/ejemplos', async (req, res) => {
    const parsed = exampleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Datos inválidos.' });
      return;
    }
    try {
      // Los ejemplos se guardan ya sin datos sensibles
      const saved = await examples.add({
        ...redactExample(parsed.data),
        createdAt: new Date().toISOString(),
        by: res.locals['user']?.email
      });
      res.status(saved ? 201 : 200).json({ saved });
    } catch (error) {
      console.error('Error guardando ejemplo:', error);
      res.status(500).json({ error: 'No se pudo guardar el ejemplo.' });
    }
  });

  return router;
}
