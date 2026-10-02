# Backend de buscador-notas

API en Node + Express + TypeScript. Hoy expone el asistente de IA; está pensada para absorber poco a poco lo que ahora vive en Firebase (por ejemplo, migrar las notas a PostgreSQL).

## Puesta en marcha

```bash
npm install
npm run dev              # http://localhost:3000
```

Antes, completa `.env` (hay una plantilla en `.env.example`; el `.env` está en `.gitignore`).

## Conseguir la clave de Gemini

1. Entra a https://aistudio.google.com/apikey con tu cuenta.
2. Presiona **Create API key** y elige o crea un proyecto de Google Cloud.
3. Copia la clave y pégala en `.env`: `GEMINI_API_KEY=...`

Notas:
- `gemini-flash-latest` funciona en la capa gratuita. Los modelos "Pro" no tienen cuota gratuita (error 429) y los modelos antiguos como `gemini-2.5-pro` ya no están disponibles para cuentas nuevas (error 404). Para ver los modelos que ofrece tu clave, consúltalos en AI Studio.
- **Límites gratuitos:** cada modelo tiene su propia cuota diaria. El backend prueba en orden `GEMINI_MODEL` y `GEMINI_FALLBACK_MODELS` (incluye modelos *flash-lite* y Gemma, también gratuitos) y recuerda unos minutos los modelos que ya no tienen cuota. La suscripción "Gemini Pro" de la cuenta institucional no incluye acceso por API, así que no sirve para esto.
- En la capa gratuita Google puede usar los datos enviados para mejorar sus modelos. Como las notas pueden contener información interna (IPs, servidores), evita incluir credenciales o datos sensibles, o usa un proyecto con facturación activada (el nivel de pago no usa los datos para entrenar).
- Si tu organización bloquea AI Studio, pide a su administrador una clave o acceso a Gemini por API.

## Cambiar de proveedor

`AI_PROVIDER=gemini` (por defecto) o `AI_PROVIDER=claude` (requiere `ANTHROPIC_API_KEY`). El código de cada proveedor está en [src/gemini.ts](src/gemini.ts) y [src/restructure.ts](src/restructure.ts); ambos comparten el mismo prompt.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servicio |
| POST | `/api/notas/reestructurar` | Recibe `{ title, tag, content }` y devuelve `{ content }` con la nota reestructurada. No guarda nada. |

`/api/notas/*` exige el header `Authorization: Bearer <ID token de Firebase>`; el backend valida el token con el `projectId` de Firebase, así que solo usuarios con sesión pueden gastar IA. Hay un límite de 10 solicitudes por minuto por IP y de 20.000 caracteres por nota.

## Ajustar el comportamiento de la IA

El prompt está en [src/prompt.ts](src/prompt.ts): formato por categoría (PROCEDIMIENTOS, INSTRUCTIVOS, SERVIDORES) y reglas ("no inventar", "conservar comandos/IPs", "marcar dudas con [REVISAR]").

## Cómo "aprende" el estilo del equipo

Cada vez que alguien usa ✨ Ajustar con IA, presiona *Aplicar y editar* y guarda la nota, la app envía el par **original → versión final** a `POST /api/notas/ejemplos`. El backend lo guarda en `data/examples.jsonl` (una línea JSON por ejemplo, ignorado por git) y, en cada nueva reestructuración, incluye hasta 3 ejemplos en el prompt (los de la misma categoría y más recientes primero, con un tope de 8.000 caracteres). Así la IA imita la estructura, el nivel de detalle y el tono que el equipo realmente aprueba, sin entrenar ningún modelo.

- No se guarda nada si la persona descarta la propuesta, o si guarda sin cambios respecto al original.
- Puedes sembrar ejemplos a mano agregando líneas a `data/examples.jsonl` con este formato: `{"tag":"PROCEDIMIENTOS","title":"...","original":"...","final":"...","createdAt":"2026-01-01T00:00:00Z"}`.
- Si algún día se acumulan cientos de ejemplos, ese archivo sirve como base para un ajuste fino (*fine-tuning*) de un modelo propio.
- El almacenamiento está detrás de la interfaz `ExamplesStore` ([src/examples.ts](src/examples.ts)), para poder moverlo a PostgreSQL sin tocar el resto.

## Datos sensibles

Antes de llamar a la IA, [src/redact.ts](src/redact.ts) cambia contraseñas (`password: x`, `clave es x`...), tokens conocidos, credenciales en URLs, llaves privadas e IPs por marcadores (`<SECRET_1>`, `<IP_1>`), y los restaura en la respuesta. La IA nunca ve los valores reales. Si la IA omite algún marcador, la propuesta incluye un aviso `[REVISAR: ...]` con el dato para que no se pierda. Los ejemplos aprobados también se guardan y envían ya con marcadores.

Limitaciones: la detección se basa en patrones; una contraseña escrita sin etiqueta (por ejemplo, "entra con admin y Tr0ub4dor") no se detecta. La respuesta de la ruta incluye `redacted` (cuántos datos se ocultaron) para mostrarlo en la app.

## Scripts

- `npm run dev` – desarrollo con recarga
- `npm test` – pruebas
- `npm run build` / `npm start` – compilar y ejecutar
