# 0004 · Las marcas de tiempo de negocio salen del reloj de Postgres

**Contexto.** Las columnas `created_at` se llenan con `now()` en la base, y el esquema
exige orden temporal con CHECKs (`assigned_at >= created_at`, `resolved_at >=
created_at`, `closed_at >= created_at`). La API y la base corren en máquinas distintas
(en local: Node en Windows y Postgres en Docker; en producción: la API y RDS).

**Problema encontrado.** La primera versión de "tomar" y "cerrar" usaba `new Date()` de
Node. En los tests, `chk_escalations_assigned_after_created` y
`chk_conversations_closed_after_created` rechazaron escrituras: el reloj de Node iba
**~1 ms atrasado** respecto al del contenedor. En producción habría sido un error 500
intermitente y difícil de reproducir.

**Decisión.** Dentro de una transacción, "ahora" se obtiene con `SELECT now()`
(`src/utils/dbTime.ts`). Todo lo confirmado antes tiene una hora menor o igual, así que
los CHECKs no pueden fallar por desfase de relojes. Los mensajes usan
`clock_timestamp()` como default en la base (varios en la misma transacción quedan
ordenados).

**Consecuencias.** Una consulta extra y trivial por operación de escritura de estado.
Queda como regla: **no** escribir fechas de negocio con `new Date()` si se comparan con
columnas llenadas por la base.
