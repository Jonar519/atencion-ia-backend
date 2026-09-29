# 0002 · Esquema de sesión del staff

**Contexto.** Agentes y administradores acceden a datos personales de clientes de un
banco. Un token robado por XSS no debe servir por mucho tiempo, y un refresh token
robado debe detectarse.

**Decisión.** Mismo esquema que el Proyecto 1:

- **Access token**: JWT HS256 de 15 min, en `Authorization: Bearer`. El frontend lo
  guarda **solo en memoria**. Se fijan algoritmo, emisor (`atencion-ia`) y **audiencia**
  (`atencion-ia-staff`): los futuros tokens del widget de cliente tendrán otra audiencia
  y no podrán usarse contra el panel.
- **Refresh token**: 32 bytes aleatorios en cookie `httpOnly`, `SameSite=Strict`,
  `Path=/api/auth`, `Secure` en producción. En la base solo su SHA-256.
- **Rotación** en cada `/refresh`; **reutilización** de un token ya rotado ⇒ se revoca
  la familia (robo probable). Ventana de gracia de 10 s ⇒ 409 (dos pestañas
  refrescando a la vez).
- `/refresh` y `/logout` exigen el encabezado `X-Requested-With: atencion-ia` y un
  `Origin` permitido (CSRF).
- **Nuevo respecto al Proyecto 1:** no hay registro público (las cuentas las crea un
  admin); la contraseña mínima sube a 12 caracteres (máximo 72 **bytes**, el límite
  real de bcrypt); desactivar o cambiar el rol de alguien revoca todas sus sesiones.

**Consecuencia conocida.** El access token es autocontenido: tras desactivar a un
agente, su token actual sigue válido hasta 15 min. Mitigación: las operaciones que
cambian estado (tomar una conversación, responder) vuelven a comprobar `is_active` en la
base. Probado en `tests/integration/conversations.test.ts`.
