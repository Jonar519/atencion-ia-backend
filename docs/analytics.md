# Analítica del servicio (Fase 7)

`GET /api/admin/analytics?days=1|7|30|90` (solo admin; por defecto 7) y la pantalla
`#/admin/analytics`. Solo conteos y promedios: ningún id, nombre ni texto de clientes.
Código: `src/modules/analytics/`. Pruebas con números calculados a mano:
`tests/integration/adminTools.test.ts` y `tests/unit/csat.test.ts`.

La ventana es `[ahora − N días, ahora)` con el reloj de la base. Las horas se muestran en
**America/Bogota** (UTC−5, sin horario de verano).

## Métricas

| Métrica                                                | Qué cuenta                                                                                                                                                    | Qué NO cuenta                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Tiempo de resolución** (promedio y mediana, minutos) | Conversaciones **cerradas en la ventana** como `resolved_by_ai` o `resolved_by_agent`; tiempo = `closed_at − created_at`. También por quién resolvió.         | Abandonos, inactividad y spam: no son resoluciones. |
| **Tasa de escalamiento** (%)                           | De las conversaciones **creadas en la ventana**, las que tuvieron al menos un escalamiento. Desglose por motivo (una conversación cuenta una vez por motivo). | —                                                   |
| **Volumen por hora**                                   | Conversaciones **creadas en la ventana**, por hora del día (0–23) en hora de Bogotá.                                                                          | —                                                   |
| **CSAT (SIMULADO)**                                    | Nota 1–5 por conversación cerrada en la ventana, con la regla de abajo. Se reporta el % de notas 4–5, el promedio y la distribución.                          | Spam.                                               |

Se muestran promedio **y** mediana del tiempo de resolución porque un solo caso largo (p. ej. uno
que quedó abierto de un día para otro) sube mucho el promedio: con los datos de la prueba, promedio
380 min y mediana 35 min.

## CSAT simulado: qué es y qué no es

**No es satisfacción real.** El sistema todavía no le pregunta al cliente cómo le fue. Para que el
tablero tenga la forma que tendrá con encuestas reales, cada conversación cerrada recibe una nota
con esta regla fija (`src/modules/analytics/csat.ts`):

```
nota = base según cómo terminó  +  (−1 si tardó más de 30 min)  +  variación del id
       limitada a 1…5
```

| Cómo terminó            | Base     |
| ----------------------- | -------- |
| Resuelta por la IA      | 4        |
| Resuelta por un asesor  | 4        |
| Cerrada por inactividad | 3        |
| El cliente abandonó     | 2        |
| Spam                    | no entra |

La **variación** es −1, 0 o +1 según el primer byte del SHA-256 del id de la conversación (módulo 3).
Es **determinista**: con los mismos datos el número es siempre el mismo, se puede recalcular a mano y
no cambia al recargar. La API devuelve `csat.simulated: true` y la pantalla lo rotula "simulado".

**Para reemplazarlo por uno real:** una encuesta de 1–5 al cerrar la conversación (widget) guardada
en una tabla propia; `summarizeCsat()` se reutiliza tal cual con las notas reales.

## No medido

- Rendimiento con volúmenes grandes: las consultas usan `created_at`/`closed_at` de `conversations`
  sin índice dedicado a la analítica. Con los datos del curso responden al instante; con millones de
  filas haría falta un índice o una tabla de agregados diarios.
