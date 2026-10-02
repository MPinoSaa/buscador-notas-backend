import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { FileExamplesStore, MemoryExamplesStore, selectExamples, type Example } from './examples.js';
import { buildSystemPrompt } from './prompt.js';
import { RestructureError } from './restructure.js';

const validUser = async (token: string) => {
  if (token !== 'ok') throw new Error('bad');
  return { uid: 'u1', email: 'a@a.com' };
};

const body = { title: 'Backup', tag: 'PROCEDIMIENTOS', content: 'copiar la bd y luego comprimir' };
const makeApp = (restructure = vi.fn(), examples = new MemoryExamplesStore()) =>
  createApp({ verifyToken: validUser, restructure, examples });

const example = (over: Partial<Example> = {}): Example => ({
  tag: 'PROCEDIMIENTOS',
  title: 't',
  original: 'orig',
  final: 'fin',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over
});

describe('POST /api/notas/reestructurar', () => {
  it('rechaza sin token', async () => {
    await request(makeApp()).post('/api/notas/reestructurar').send(body).expect(401);
  });

  it('rechaza un token inválido', async () => {
    await request(makeApp()).post('/api/notas/reestructurar').set('Authorization', 'Bearer malo').send(body).expect(401);
  });

  it('valida el cuerpo', async () => {
    const restructure = vi.fn();
    await request(makeApp(restructure)).post('/api/notas/reestructurar').set('Authorization', 'Bearer ok').send({ title: 'x', content: '  ' }).expect(400);
    expect(restructure).not.toHaveBeenCalled();
  });

  it('devuelve el contenido reestructurado e incluye los ejemplos guardados', async () => {
    const examples = new MemoryExamplesStore();
    await examples.add(example());
    const restructure = vi.fn().mockResolvedValue('OBJETIVO\n1. Copiar la BD');

    const res = await request(makeApp(restructure, examples)).post('/api/notas/reestructurar').set('Authorization', 'Bearer ok').send(body).expect(200);
    expect(res.body).toEqual({ content: 'OBJETIVO\n1. Copiar la BD', redacted: 0 });
    expect(restructure).toHaveBeenCalledWith({ ...body, examples: [example()] });
  });

  it('propaga el estado de los errores controlados de la IA', async () => {
    const restructure = vi.fn().mockRejectedValue(new RestructureError('saturada', 429));
    const res = await request(makeApp(restructure)).post('/api/notas/reestructurar').set('Authorization', 'Bearer ok').send(body).expect(429);
    expect(res.body.error).toBe('saturada');
  });
});

describe('POST /api/notas/ejemplos', () => {
  const payload = { title: 'Backup', tag: 'PROCEDIMIENTOS', original: 'desordenado', final: 'ordenado' };

  it('exige sesión y valida los datos', async () => {
    const app = makeApp();
    await request(app).post('/api/notas/ejemplos').send(payload).expect(401);
    await request(app).post('/api/notas/ejemplos').set('Authorization', 'Bearer ok').send({ ...payload, final: '' }).expect(400);
  });

  it('guarda el ejemplo con el autor y evita duplicados', async () => {
    const examples = new MemoryExamplesStore();
    const app = makeApp(vi.fn(), examples);

    await request(app).post('/api/notas/ejemplos').set('Authorization', 'Bearer ok').send(payload).expect(201, { saved: true });
    await request(app).post('/api/notas/ejemplos').set('Authorization', 'Bearer ok').send(payload).expect(200, { saved: false });
    expect(examples.items).toHaveLength(1);
    expect(examples.items[0]).toMatchObject({ ...payload, by: 'a@a.com' });
  });
});

describe('selectExamples', () => {
  it('prioriza la misma categoría y lo más reciente', () => {
    const all = [
      example({ tag: 'OTROS', original: 'o1', createdAt: '2026-03-01T00:00:00Z' }),
      example({ tag: 'PROCEDIMIENTOS', original: 'p-viejo', createdAt: '2026-01-01T00:00:00Z' }),
      example({ tag: 'PROCEDIMIENTOS', original: 'p-nuevo', createdAt: '2026-02-01T00:00:00Z' })
    ];
    expect(selectExamples(all, 'procedimientos', 2).map(e => e.original)).toEqual(['p-nuevo', 'p-viejo']);
  });

  it('respeta el máximo de ejemplos y de caracteres', () => {
    const big = example({ original: 'x'.repeat(5000), final: 'y'.repeat(5000) });
    const small = example({ original: 'a', final: 'b', createdAt: '2025-01-01T00:00:00Z' });
    expect(selectExamples([big, small], 'PROCEDIMIENTOS', 3, 8000)).toEqual([small]);
    expect(selectExamples([small, small, small, small], 'PROCEDIMIENTOS', 3)).toHaveLength(3);
  });
});

describe('FileExamplesStore', () => {
  it('persiste en disco, ignora líneas dañadas y no duplica', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ejemplos-'));
    try {
      const file = path.join(dir, 'sub', 'examples.jsonl');
      const store = new FileExamplesStore(file);
      expect(await store.list()).toEqual([]);
      expect(await store.add(example())).toBe(true);
      expect(await store.add(example())).toBe(false);
      expect(await new FileExamplesStore(file).list()).toEqual([example()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildSystemPrompt', () => {
  it('adapta el formato a la categoría', () => {
    expect(buildSystemPrompt('procedimientos')).toContain('PROCEDIMIENTO');
    expect(buildSystemPrompt('SERVIDORES')).toContain('FICHA TÉCNICA');
    expect(buildSystemPrompt('LO QUE SEA')).toContain('títulos de sección');
  });

  it('incluye los ejemplos aprobados solo si existen', () => {
    expect(buildSystemPrompt('OTROS')).not.toContain('<ejemplo>');
    const prompt = buildSystemPrompt('OTROS', [example({ original: 'ORIGINAL-X', final: 'FINAL-X' })]);
    expect(prompt).toContain('<ejemplo>');
    expect(prompt).toContain('ORIGINAL-X');
    expect(prompt).toContain('FINAL-X');
  });
});
