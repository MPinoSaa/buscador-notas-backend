import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { MemoryExamplesStore } from './examples.js';
import { createRedactor } from './redact.js';

describe('createRedactor', () => {
  it('oculta IPs y las restaura, reutilizando el marcador del mismo valor', () => {
    const r = createRedactor();
    const out = r.redact('Servidor 192.168.1.10 y réplica 10.0.0.5, de nuevo 192.168.1.10');
    expect(out).toBe('Servidor <IP_1> y réplica <IP_2>, de nuevo <IP_1>');
    expect(r.restore(out)).toBe('Servidor 192.168.1.10 y réplica 10.0.0.5, de nuevo 192.168.1.10');
    expect(r.count).toBe(2);
  });

  it('oculta contraseñas en distintos formatos sin tocar el resto del texto', () => {
    const r = createRedactor();
    const out = r.redact('usuario: admin\ncontraseña: Pa$$w0rd!\npassword = "con espacios"\nla clave es abc123.\nclaves de acceso en Bitwarden');
    expect(out).not.toContain('Pa$$w0rd!');
    expect(out).not.toContain('con espacios');
    expect(out).not.toContain('abc123');
    expect(out).toContain('usuario: admin');
    expect(out).toContain('claves de acceso en Bitwarden');
    expect(out).toContain('contraseña: <SECRET_1>');
    expect(out).toMatch(/la clave es <SECRET_3>\./);
    expect(r.restore(out)).toBe('usuario: admin\ncontraseña: Pa$$w0rd!\npassword = "con espacios"\nla clave es abc123.\nclaves de acceso en Bitwarden');
  });

  it('oculta credenciales en URLs, tokens conocidos y llaves privadas', () => {
    const r = createRedactor();
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    const text = `postgres://app:s3cr3t@db.local/ventas\nGH ghp_${'a'.repeat(36)}\n${key}`;
    const out = r.redact(text);
    expect(out).toContain('postgres://app:<SECRET_1>@db.local/ventas');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('MIIabc');
    expect(r.restore(out)).toBe(text);
  });

  it('no toca texto sin datos sensibles y no vuelve a ocultar marcadores', () => {
    const r = createRedactor();
    expect(r.redact('Reiniciar nginx y revisar el estado')).toBe('Reiniciar nginx y revisar el estado');
    expect(r.redact('password: <SECRET_1>')).toBe('password: <SECRET_1>');
    expect(r.count).toBe(0);
  });

  it('detecta datos que la IA omitió', () => {
    const r = createRedactor();
    r.redact('IP 10.0.0.1 y clave: hunter2');
    expect(r.missingFrom('IP <IP_1> solamente')).toEqual(['hunter2']);
  });

  it('usa marcadores distintos en el espacio de nombres de ejemplos', () => {
    expect(createRedactor('EJ').redact('10.0.0.1')).toBe('<IP_EJ_1>');
  });
});

describe('la ruta oculta los datos sensibles antes de llamar a la IA', () => {
  const user = async () => ({ uid: 'u', email: 'a@a.com' });

  it('la IA recibe marcadores y la respuesta vuelve con los valores reales', async () => {
    const restructure = vi.fn().mockImplementation(async ({ content }) => `PASOS\n1. ${content}`);
    const app = createApp({ verifyToken: user, restructure, examples: new MemoryExamplesStore() });

    const res = await request(app)
      .post('/api/notas/reestructurar')
      .set('Authorization', 'Bearer x')
      .send({ title: 'Acceso', tag: 'SERVIDORES', content: 'entrar a 10.1.1.1 con password: Sup3rSecreta' })
      .expect(200);

    const sent = restructure.mock.calls[0]![0];
    expect(sent.content).not.toContain('10.1.1.1');
    expect(sent.content).not.toContain('Sup3rSecreta');
    expect(res.body.content).toContain('10.1.1.1');
    expect(res.body.content).toContain('Sup3rSecreta');
    expect(res.body.redacted).toBe(2);
  });

  it('avisa si la IA omite un dato sensible', async () => {
    const restructure = vi.fn().mockResolvedValue('Nota sin los datos');
    const app = createApp({ verifyToken: user, restructure, examples: new MemoryExamplesStore() });

    const res = await request(app)
      .post('/api/notas/reestructurar')
      .set('Authorization', 'Bearer x')
      .send({ title: 'Acceso', tag: 'OTROS', content: 'clave: hunter2' })
      .expect(200);
    expect(res.body.content).toContain('[REVISAR');
    expect(res.body.content).toContain('hunter2');
  });

  it('los ejemplos se guardan y se envían sin datos sensibles', async () => {
    const examples = new MemoryExamplesStore();
    const restructure = vi.fn().mockResolvedValue('ok');
    const app = createApp({ verifyToken: user, restructure, examples });

    await request(app)
      .post('/api/notas/ejemplos')
      .set('Authorization', 'Bearer x')
      .send({ title: 'T', tag: 'OTROS', original: 'password: abc999', final: 'CLAVE\npassword: abc999 en 10.9.9.9' })
      .expect(201);
    expect(JSON.stringify(examples.items)).not.toContain('abc999');
    expect(JSON.stringify(examples.items)).not.toContain('10.9.9.9');

    // También se limpian ejemplos antiguos que ya estuvieran guardados con datos reales
    await examples.add({ tag: 'OTROS', title: 'viejo', original: 'pwd: zzz111', final: 'pwd: zzz111', createdAt: '2020-01-01T00:00:00Z' });
    await request(app)
      .post('/api/notas/reestructurar')
      .set('Authorization', 'Bearer x')
      .send({ title: 'Otra', tag: 'OTROS', content: 'algo' })
      .expect(200);
    expect(JSON.stringify(restructure.mock.calls[0]![0].examples)).not.toContain('zzz111');
  });
});
