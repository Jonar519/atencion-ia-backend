# 0009 · La sesión del cliente del widget vive en una cookie httpOnly

**Contexto.** En la Fase 3 la sesión anónima del widget devolvía `{ token: "wgt_…" }` y se usaba
como `Authorization: Bearer`. En el navegador, eso obligaría a guardar el token donde JavaScript
lo pueda leer (memoria se pierde al recargar; `localStorage` lo expone a cualquier XSS), lo mismo
que se evitó para el staff ([ADR 0002](0002-esquema-de-sesion.md)).

**Decisión.**

- Si `POST /api/widget/sessions` llega con `X-Requested-With: atencion-ia` (el frontend), el token
  se entrega en la cookie `atencion_ia_widget` (httpOnly, `SameSite=Strict`, `Path=/`, `Secure` con
  `COOKIE_SECURE=true`) y **no** en el cuerpo.
- Las escrituras autenticadas por esa cookie exigen el mismo header y un `Origin` permitido (CSRF). El header no se puede
  enviar desde otro sitio sin pasar por CORS.
- `Authorization: Bearer wgt_…` sigue aceptado (curl, demo de la Fase 3, integraciones); sin cookie
  no hay riesgo de CSRF.
- `GET /api/widget/session` permite al frontend saber si ya hay sesión al recargar;
  `POST /api/widget/session/end` la revoca y borra la cookie.
- El WebSocket usa la cookie del upgrade, con verificación de `Origin` ([ADR 0008](0008-tiempo-real-solo-recepcion.md)).

**Alternativas consideradas.** _Token en `localStorage`_: expuesto a XSS. _Token solo en
memoria_: el cliente perdería su conversación al recargar.

**Consecuencias.** El frontend y la API deben compartir origen (el proxy de Vite lo resuelve en
desarrollo). Un XSS podría actuar mientras la página está abierta, pero no llevarse la sesión.

**Evidencia.** `tests/integration/widget.test.ts` (cookie httpOnly sin token en el cuerpo, escritura
por cookie sin header → 403, Bearer sigue funcionando). Mutaciones 21–22.
