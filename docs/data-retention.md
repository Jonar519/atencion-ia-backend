# Retención de datos del staff (Fase 7)

Qué guarda el sistema sobre las personas del banco que usan el panel (asesores y administradores),
cuánto tiempo, cómo se exporta y qué pasa al eliminar una cuenta. Los datos de los **clientes**
(conversaciones, llamadas) tienen su propia política: `docs/privacy-voice.md`.

## Qué se guarda

| Dato                              | Dónde                               | Forma                                                                                      | Vida                                                                                |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Nombre, correo, rol, teléfono     | `staff_users`                       | En claro (se necesitan para operar)                                                        | Mientras la cuenta exista; al eliminarla se anonimiza                               |
| Contraseña                        | `staff_users.password_hash`         | bcrypt (costo 10)                                                                          | Idem                                                                                |
| Secreto de la verificación (TOTP) | `staff_users.mfa_secret_encrypted`  | AES-256-GCM con `MFA_ENCRYPTION_KEY` (fuera de la base)                                    | Hasta desactivar la MFA o eliminar la cuenta                                        |
| Códigos de respaldo               | `mfa_backup_codes`                  | SHA-256 (se muestran UNA vez)                                                              | Hasta usarlos, regenerarlos o eliminar la cuenta                                    |
| Foto (avatar)                     | Almacenamiento (`services/storage`) | Recorte de 256 px hecho en el navegador                                                    | Hasta cambiarla, quitarla o eliminar la cuenta                                      |
| Sesiones                          | `refresh_tokens`                    | Hash del token; IP **truncada** (x.y.z.0 / IPv6 /48); ubicación **aproximada**; user agent | Token: 7 días. Filas revocadas: se conservan como historial (ver "No implementado") |
| Enlaces de un solo uso            | `staff_tokens`                      | SHA-256 del token                                                                          | 5 a 15 min de validez (la base impone ≤ 30 min)                                     |
| Correos simulados (modo mock)     | `email_outbox`                      | Texto del correo (incluye el enlace)                                                       | Se borran al eliminar la cuenta; en desarrollo, a mano                              |
| Auditoría                         | `audit_log`                         | Acción, id de la entidad; IP como HMAC; sin contenido                                      | Registro del banco: no se borra con la cuenta (ver abajo)                           |
| Intentos de login fallidos        | `login_attempts`                    | SHA-256 del correo, contador                                                               | Se borra al entrar bien, al restablecer o al eliminar                               |

**La IP nunca se guarda completa** en las sesiones: `src/utils/ip.ts` la trunca y la base lo exige
con un CHECK (migración 015). La ubicación se calcula con una base **local** (DB-IP Lite o el mock);
la IP no se envía a ningún servicio. Se muestra siempre como "ubicación aproximada".

## Exportar (derecho de acceso)

- La persona: **Mi perfil → Tus datos personales → Descargar mis datos** (`GET /api/profile/export`).
- Un administrador, para un asesor: `GET /api/staff/:id/export`.

El JSON (`format: "atencion-ia/staff-export@1"`) incluye el perfil, las sesiones (con IP truncada),
la actividad de auditoría (últimos 1000 registros), los ids/estados/fechas de las conversaciones que
atendió, cuántos mensajes envió y sus participaciones en llamadas. **No** incluye el contenido de
las conversaciones: pertenece a los clientes del banco. Tampoco hashes, secretos ni tokens.

## Eliminar la cuenta de un asesor = anonimizarla

`POST /api/staff/:id/anonymize` (solo admin). No se borra la fila porque los mensajes, llamadas y
escalamientos la referencian (FK `RESTRICT`) y son registro del banco; se borra todo lo **personal**:

- Nombre → "Agente eliminado xxxxxxxx"; correo → `eliminado-<id>@anonimizado.invalid`.
- Teléfono, foto (también el archivo), secreto MFA, códigos de respaldo y enlaces pendientes → borrados.
- Contraseña → reemplazada por un hash de un valor aleatorio que nadie conoce; cuenta inactiva.
- Sesiones → revocadas, y se borra su IP truncada, ubicación y user agent.
- Correos simulados que lo mencionan (`email_outbox`) y su contador de intentos fallidos → borrados.
- Es **definitivo**: la base impide reactivarla (`chk_staff_users_deleted`) y la API responde 409.

**Reasignación obligatoria antes de eliminar.** Si el asesor tiene conversaciones en atención o
está en una llamada, la API responde 409 con `{ activeConversations, activeCalls }`. Primero se
reasigna cada caso con `POST /api/conversations/:id/reassign { agentId }` (solo admin; respeta el
máximo de conversaciones del destino y deja un mensaje de sistema "X continúa con la conversación").
La comprobación se repite dentro de la transacción con la fila bloqueada, así que un "tomar caso"
simultáneo no se cuela.

Solo se eliminan cuentas de **asesor**. Una cuenta de administrador primero pierde el rol (así
nunca se queda la plataforma sin administradores por un clic) y nadie puede eliminarse a sí mismo.

**Qué queda después:** los mensajes que escribió (con el nombre anonimizado), su id en la auditoría
(seudónimo: sin el resto de sus datos ya no identifica a nadie fuera del banco) y las métricas
agregadas.

## Invitaciones (alta de asesores)

- La única forma de tener cuenta es una invitación de un admin. Mientras está pendiente, la cuenta
  guarda solo nombre, correo, rol, quién invitó y cuándo; no tiene contraseña, MFA ni sesiones.
- El correo de invitación queda en `email_outbox` con el proveedor simulado (se borra con la cuenta
  si se anonimiza).
- **Cancelar** una invitación pendiente borra la cuenta: nunca se usó y nada la referencia.
- No se guarda ninguna preferencia de tema (migración 019): la app sigue el tema del sistema.

## Recuperación y verificación en dos pasos (resumen de reglas)

- Recuperar contraseña: misma respuesta, al instante, exista o no el correo; enlace de 15 min, de un
  solo uso; pedir otro invalida el anterior; restablecer cierra **todas** las sesiones y **no**
  desactiva la MFA.
- MFA: obligatoria para admin (se activa en el siguiente login), opcional para asesores. RFC 6238
  (SHA-1, 6 dígitos, 30 s, ±1 paso), anti-replay por paso, 10 códigos de respaldo de un solo uso.
  Cada código incorrecto cuenta para el bloqueo progresivo de la cuenta.
- Si un admin pierde el teléfono y los códigos, otro admin no puede desactivarle la MFA desde la
  API (a propósito). Procedimiento manual documentado en `docs/demo-fase7.md`.

## No implementado (honesto)

- **Purga automática** de filas antiguas de `refresh_tokens` revocadas/vencidas, `staff_tokens`
  usados y `email_outbox`: hoy crecen sin límite. Es un job de mantenimiento pendiente (mismo
  patrón que `voice:purge`).
- **Retención de `audit_log`**: sin plazo definido (depende de la regulación financiera aplicable,
  que no se determinó en el curso).
- Copias de seguridad: si existen, conservarían los datos anteriores a la anonimización hasta su
  rotación. No hay backups configurados en este proyecto.
