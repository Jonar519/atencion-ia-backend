# Demo de la Fase 7 — identidad profesional y evolución visual

Todo funciona con proveedores simulados (IA, voz, correo, ubicación y archivos): no hace falta
ninguna credencial. Comandos para **cmd.exe**.

| Bloque | Tema                                                                 | Secciones |
| ------ | -------------------------------------------------------------------- | --------- |
| A      | Identidad: recuperación, verificación en dos pasos, sesiones, perfil | 0–5       |
| B      | Roles y administración: guardas, analítica, equipo, respuestas, KB   | 6–10      |
| C      | Adjuntos en el chat (imagen y PDF) sin que la IA vea el archivo      | 11        |
| D1     | La llamada "en vivo": forma de onda, color y ánimo del cliente       | 12        |
| D2     | Estados de carga, error, vacío y conectividad; foco del título       | 13        |
| —      | Qué protege cada bloque, verificación final y lo no medido           | 14–16     |

**Recorrido corto (unos 15 minutos), si no hay tiempo para todo:** 2 (entrar como admin con el
código) → 6 (un asesor no ve la administración) → 7 (analítica) → 11 (adjuntar un PDF y probar que
la IA no lo lee) → 12 (llamar y escalar: el borde cambia de color) → 13, pasos 3 y 4 (Reintentar sin
recargar y sin internet).

## 0. Preparar tu base de desarrollo (una sola vez)

Las migraciones 015 (identidad), 016 (respuestas predefinidas) y 017 (adjuntos) agregan sus tablas; `migrate.bat`
aplica solo las que faltan. Tus procesos `npm run dev` y `npm run worker`
pueden seguir abiertos.

```bat
cd atencion-ia-database
scripts\migrate.bat
cd ..\atencion-ia-backend
npm install
npx prisma generate
```

(`npm install` trae las dependencias nuevas de la Fase 7: correo, ubicación, S3 y el QR.)

(Si `prisma generate` dice `EPERM` sobre un `.dll`, es porque tu `npm run dev` lo tiene abierto: los
tipos igual se generan. Reinicia `npm run dev` para que el cliente nuevo cargue.)

Frontend en otra ventana: `cd atencion-ia-frontend` y `npm run dev` → http://localhost:5174.

**Leer los correos simulados** (el proveedor `mock` no envía nada; los guarda en `email_outbox`):

```bat
docker exec -it atencion_ia_postgres psql -U postgres -d atencion_ia -c "SELECT id, to_address, template, created_at FROM email_outbox ORDER BY id DESC LIMIT 5"
docker exec -it atencion_ia_postgres psql -U postgres -d atencion_ia -At -c "SELECT body_text FROM email_outbox ORDER BY id DESC LIMIT 1"
```

# Bloque A — identidad profesional

## 1. Recuperar la contraseña

1. http://localhost:5174/#/agente/login → **¿Olvidaste tu contraseña?**
2. Escribe `laura@cordillera.example` → **Enviar enlace**. El mensaje es el mismo si escribes un
   correo que no existe (pruébalo: `nadie@cordillera.example`; en `email_outbox` no aparece nada).
3. Con el segundo comando de arriba copia el enlace (`http://localhost:5174/#/agente/restablecer?token=…`)
   y ábrelo.
4. Prueba primero una contraseña que contenga `laura`: el error dice **"No debe contener tu
   nombre"** y el enlace NO se gasta. Luego una válida de 12+ caracteres → "Tu contraseña cambió".
5. Vuelve a abrir el mismo enlace y repite: ahora dice que **ya se usó**. Si tenías el panel abierto
   en otra pestaña, esa sesión se cerró.

## 2. Activar la verificación en dos pasos y entrar con el código

**Como admin (obligatoria):** entra con `admin@cordillera.example` / `Password123!`. En vez del panel
aparece **Activa la verificación en dos pasos** con un QR. Escanéalo con Google Authenticator o
Microsoft Authenticator, escribe los 6 dígitos → **Activar y entrar** → guarda los 10 códigos de
respaldo, marca **Ya guardé mis códigos** → **Continuar**.

**Como asesor (opcional):** entra como `laura@cordillera.example` → clic en tu nombre (arriba a la
derecha) → **Mi perfil** → sección **Verificación en dos pasos** → **Activar**.

Luego **Salir** y vuelve a entrar: tras la contraseña pide el **código**. Prueba:

- `000000` → "El código no es correcto" (cinco seguidos matan el paso y cuentan para el bloqueo).
- El código de la app → entras.
- Otra vez, con un código de respaldo (`abcd-efgh`, mayúsculas o sin guion también sirven) →
  entras y aparece "Usaste un código de respaldo. Te quedan 9".

Sin teléfono a mano, la clave que aparece bajo el QR sirve para calcular el código; por ejemplo,
con Node (reemplaza la clave):

```bat
node -e "const c=require('crypto'),k='CLAVE-DEL-QR'.replace(/ /g,''),a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b=0,v=0,o=[];for(const x of k){v=v<<5|a.indexOf(x);b+=5;if(b>=8){o.push(v>>>b-8&255);b-=8}}const t=Buffer.alloc(8);t.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=c.createHmac('sha1',Buffer.from(o)).update(t).digest(),f=h[h.length-1]&15;console.log(String((h.readUInt32BE(f)&0x7fffffff)%1e6).padStart(6,'0'))"
```

**Un admin perdió el teléfono y los códigos:** no hay botón para eso, a propósito. Con acceso al
servidor: `npm run staff:reset-mfa -- admin@cordillera.example` (queda en la auditoría y cierra sus
sesiones; en el próximo login deberá activarla de nuevo).

## 3. Ver las sesiones activas

1. Entra con la misma cuenta en otro navegador (o en una ventana de incógnito).
2. En el primero: **Mi perfil → Sesiones activas**. Cada sesión muestra navegador y sistema, la
   **ubicación aproximada** ("Red local" en tu equipo; con `GEO_PROVIDER=dbip` y el archivo de
   DB-IP, la ciudad), la red truncada y las fechas. La actual dice **Esta sesión**.
3. **Cerrar** en la otra sesión, o **Cerrar sesión en los demás dispositivos**: en el otro navegador,
   la siguiente renovación lo manda al login.

En la base no hay IP completas:

```bat
docker exec -it atencion_ia_postgres psql -U postgres -d atencion_ia -c "SELECT ip_address, location_label, revoke_reason FROM refresh_tokens ORDER BY created_at DESC LIMIT 5"
```

## 4. Perfil, tema, foto y datos

- **Apariencia → Oscuro**: el panel cambia al instante y se recuerda (es parte del perfil).
- **Foto → Elegir una foto**: arrástrala o usa las flechas, **Acercar**, **Guardar foto**. Solo se
  sube el recorte de 256 px.
- **Correo**: pide la contraseña; el enlace llega al correo NUEVO (y un aviso al anterior).
- **Tus datos personales → Descargar mis datos**: JSON sin secretos ni contenido de clientes.

## 5. Eliminar la cuenta de un asesor (admin, por API)

Retención y reglas completas: `docs/data-retention.md`. Resumen: `POST /api/staff/:id/anonymize`
responde 409 mientras el asesor tenga casos en atención; se reasignan con
`POST /api/conversations/:id/reassign { "agentId": "…" }` y luego se anonimiza. Desde la interfaz:
sección 8.

# Bloque B — roles y administración

## 6. Un asesor no ve la administración (guardas por rol)

1. Entra como `laura@cordillera.example` (asesora). En la barra superior **no** aparecen los enlaces
   de administración.
2. Escribe a mano en la barra de direcciones `http://localhost:5174/#/admin/analytics`: vuelves al
   panel con el aviso "Esa sección es solo para administradores".
3. Aunque alguien se saltara la interfaz, la API responde 403 (prueba en cmd con un token de asesor
   y verás `{"error":"No tienes permisos para realizar esta acción"}`).
4. Entra como `admin@cordillera.example`: la barra muestra **Base de conocimiento · Respuestas ·
   Equipo · Analítica**.

## 7. Analítica (admin)

**Analítica**: tiempo medio y mediana de resolución, tasa de escalamiento, **CSAT con el rótulo
SIMULADO** y conversaciones por hora del día (hora de Bogotá). Cambia el **Periodo** (24 h, 7, 30,
90 días). Cada barra se puede enfocar con Tab y muestra su valor; **Ver datos** abre la tabla con
todos los números. Qué cuenta cada métrica y la regla del CSAT simulado: `docs/analytics.md`.

Para tener datos: abre `http://localhost:5174/#/chat` en otra ventana, escribe un par de mensajes,
pide "quiero hablar con un asesor" (escala), y cierra el caso desde el panel.

## 8. Equipo: reasignar y eliminar la cuenta de un asesor (admin)

1. Con un caso tomado por Laura, como admin abre **Equipo**: Laura muestra "1 caso(s) en curso" y
   **Eliminar cuenta (reasigna antes sus casos)** está deshabilitado.
2. **Reasignar 1 caso(s)** → elige a otra persona → **Reasignar**. En el chat del cliente aparece
   "… continúa con la conversación".
3. Ahora **Eliminar cuenta** → el botón cambia a **Confirmar: borrar los datos personales de …** y
   explica qué se borra → clic de nuevo. La fila queda como "Cuenta eliminada (anonimizada)".
4. **Exportar datos** (antes de eliminar) descarga su JSON.

No uses tu cuenta de Laura del seed si la quieres conservar: crea antes un asesor de prueba
(`POST /api/staff`) o haz este paso al final.

## 9. Respuestas predefinidas

1. Admin → **Respuestas** → **Nueva respuesta**: título "Saludo", texto
   `Hola {cliente}, soy {asesor}. ¿En qué te puedo ayudar?`, atajo `saludo` → **Crear**.
2. Como asesor, con un caso tomado: botón **Respuestas** junto a "Enviar" → busca `/saludo` → clic.
   El texto aparece en la caja con los nombres reemplazados, **sin enviarse**: lo revisas y
   pulsas **Enviar**.
3. Desactívala (admin) y vuelve a abrir **Respuestas** como asesor: ya no aparece.

## 10. Prioridad legible y base de conocimiento

- En la **Cola**, cada caso dice "Urgente · 90", "Alta · 60" o "Normal · 20" junto a la regla de color.
- Admin → **Base de conocimiento**: lista con estado; **Nuevo artículo** sugiere el identificador
  desde el título; solo lo **Publicado** llega al asistente (se re-indexa al guardar; el worker debe
  estar corriendo).

# Bloque C — adjuntos en el chat

Reglas completas (qué ve la IA, validación, retención): `docs/attachments.md`.

## 11. Adjuntar un PDF y una foto

1. Como cliente, en `http://localhost:5174/#/chat`: escribe "quiero hablar con un asesor".
2. Como asesora (Laura), toma el caso en el panel.
3. En el chat del cliente: **Adjuntar** → elige un PDF. **No se envía todavía**: aparece la vista
   previa con su nombre, tamaño y **Quitar**. Escribe un comentario ("¿me explicas este cargo?") y
   **Enviar**. En el panel aparece al instante una tarjeta con el nombre y **Descargar**.
4. **Adjuntar** → una foto (JPEG o PNG). Se sube re-codificada a ≤ 1600 px y **sin sus metadatos**
   (EXIF/GPS). El asesor la ve dentro del chat.
5. El asesor también puede adjuntar (botón **Adjuntar** junto a **Respuestas**).
6. Prueba un `.txt` o un `.gif`: el navegador lo rechaza con un mensaje claro. Un PDF con
   JavaScript lo rechaza el servidor ("contenido activo").

**La IA no ve el archivo.** Con una conversación que atiende la IA (sin asesor), adjunta un PDF sin
comentario: la IA responde pidiéndote que describas lo que muestra. El modelo recibió solo la señal
`[El cliente adjuntó un documento PDF. No puedes ver su contenido…]`: ni el contenido ni el nombre
del archivo (lo prueban `tests/integration/attachments.test.ts` y 5 mutaciones).

Dónde quedan los archivos: `..\atencion-ia-storage\attachments\<conversación>\`.

```bat
docker exec -it atencion_ia_postgres psql -U postgres -d atencion_ia -c "SELECT content_type, size_bytes, original_name, created_at FROM message_attachments ORDER BY created_at DESC LIMIT 5"
```

# Bloque D1 — la llamada "en vivo"

## 12. Forma de onda y transición de color durante una llamada real

Necesitas micrófono (o un auricular con micrófono). En el widget (`http://localhost:5174/#/chat`):

1. **Llamar** → acepta el aviso → permite el micrófono. La barra de la llamada es oscura y dice
   **LLAMADA EN CURSO** (cian). Habla: la **forma de onda** se mueve con tu voz (es el mismo nivel
   que el medidor de siempre). **Silenciar** la deja plana y atenuada.
2. Con el reconocimiento simulado, la **tercera frase** que digas escala la conversación (en el
   chat de texto también puedes escribir "quiero hablar con un asesor"). En ese momento el **borde
   de la barra se llena de menta de izquierda a derecha** (1,4 s, una sola vez) y queda menta.
3. En el panel, Laura **Unirse a la llamada**: la insignia de las dos barras pasa a **ASESOR
   CONECTADO** (menta). En el encabezado del caso aparece **Ánimo del cliente: …** y cambia con cada
   mensaje del cliente ("(empeoró)" / "(mejoró)").

**Movimiento reducido:** en Windows, Configuración → Accesibilidad → Efectos visuales → desactiva
"Efectos de animación" y recarga. El borde cambia a menta sin animarse y la forma de onda pasa a
una sola barra con el nivel actual.

En el E2E (`scripts\e2e.bat`, prueba de voz) esto se comprueba con la llamada real: la forma de
onda pinta píxeles a partir del audio del micrófono falso, la animación `callbar-handoff` corre
exactamente UNA vez al escalar y el borde termina en `rgb(0, 179, 126)`.

# Bloque D2 — estados de carga, error, vacío y conectividad

## 13. Ver cada estado sin romper nada

Con `npm run dev` (API 4100 y frontend 5174) abiertos. Las herramientas de desarrollo se abren con
**F12** en Chrome o Edge.

1. **Vacío que orienta.** En el widget, empieza un chat nuevo: aparece **"¿En qué te podemos
   ayudar?"** con tres preguntas de ejemplo. Al hacer clic en una se ESCRIBE en el campo (no se
   envía). En el panel con un asesor sin casos: la cola explica cuándo llegan y **Mis casos**
   ofrece **Ver la cola**.
2. **Esqueleto de carga.** F12 → pestaña **Network** → lista **No throttling** → **Slow 4G** (o
   "3G") y recarga el panel: la lista y el caso muestran rectángulos grises quietos. Vuelve a
   **No throttling**.
3. **Error + Reintentar sin recargar.** F12 → Network → clic derecho sobre la petición
   `conversations?scope=queue` → **Block request URL** y recarga: la cola dice **"No se pudieron
   cargar los casos"** con **Reintentar**. Escribe algo en cualquier campo, desbloquea la URL (pestaña
   **Network request blocking**, quita la marca) y pulsa **Reintentar**: la cola carga y lo escrito
   sigue ahí (la página no se recargó).
4. **Sin internet.** En el widget, F12 → Network → **No throttling** → **Offline**: arriba aparece
   **"Sin conexión a internet…"**. Envía un mensaje: queda **"No se envió." + Reintentar**. Vuelve a
   **No throttling**: el aviso dice **"Conexión restablecida."** unos segundos y se va; pulsa
   Reintentar en el mensaje y se envía (sin duplicarse).
5. **Reconectando.** Con el chat abierto, detén `npm run dev` del backend (Ctrl+C en su ventana) y
   espera unos segundos: **"Reconectando con el servidor…"**. Vuelve a arrancarlo: **"Conexión
   restablecida."**
6. **Foco del título.** Navega entre pantallas con el teclado: el título ya no muestra un recuadro
   al cambiar de pantalla, pero Tab sigue marcando cada botón y campo.

# Cierre de la Fase 7

## 14. Qué protege cada bloque (pruebas que rompen la regla a propósito)

`npm run test:mutations` cambia el código para romper cada regla y exige que algún test falle. Las
de la Fase 7:

| Bloque | Regla crítica                                                                     | Mutaciones                    |
| ------ | --------------------------------------------------------------------------------- | ----------------------------- |
| A      | MFA (sin replay, códigos de un solo uso, admin obligatoria, bloqueo)              | backend 40–48                 |
| A      | Enlaces de un solo uso, recuperación sin revelar cuentas, cierre de sesiones      | backend 49–57                 |
| A      | Foto (bytes mágicos), sesiones ajenas, IP truncada, anonimización                 | backend 58–65                 |
| A      | Login con MFA, códigos de respaldo, enlaces, tema, contraste medido de los tokens | frontend 32–42                |
| B      | Solo admin: respuestas, analítica, equipo; métricas y CSAT correctos              | backend 66–76; frontend 43–53 |
| C      | **La IA nunca recibe el contenido ni el nombre de un adjunto**                    | backend 77–81                 |
| C      | Archivos: bytes mágicos, PDF con contenido activo, EXIF, acceso por conversación  | backend 82–90; frontend 54–59 |
| D1     | Forma de onda, una sola animación y una vez, insignia y ánimo en vivo             | frontend 60–71                |
| D2     | Reintentar sin recargar, avisos de conexión, vacíos, foco del título, axe         | frontend 72–84                |

## 15. Verificación final (bloque E)

Resultado de la última corrida completa, con tus procesos de desarrollo detenidos y las pruebas en
bases aparte (`atencion_ia_test`, `atencion_ia_e2e`, Redis base 1):

| Qué                                                            | Resultado                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Base de datos (base nueva y vacía, como la CI)                 | 17 migraciones; la segunda corrida no aplica nada; seed idempotente; **94/94** pruebas del esquema |
| Backend: lint, typecheck, tests y build (`scripts\verify.bat`) | **413/413** tests en 34 archivos; también en orden aleatorio                                       |
| Backend: mutaciones                                            | **90/90** detectadas                                                                               |
| Frontend: lint, tests y build (`scripts\verify.bat`)           | **319/319** tests en 18 archivos; también en orden aleatorio                                       |
| Frontend: mutaciones                                           | **84/84** detectadas                                                                               |
| E2E aislado (`scripts\e2e.bat`)                                | **3/3**: texto, voz y adjuntos (axe y 0 violaciones de CSP)                                        |
| Base de desarrollo                                             | Misma huella antes y después de toda la verificación                                               |

Para repetirla (cmd.exe):

```bat
cd atencion-ia-database
scripts\test.bat
cd ..\atencion-ia-backend
scripts\verify.bat
npm run test:shuffle
npm run test:mutations
cd ..\atencion-ia-frontend
scripts\verify.bat
npm run test:mutations
scripts\e2e.bat
```

(Detén antes `npm run dev` del backend y del frontend: las mutaciones cambian el código fuente un
momento y tu servidor con recarga automática lo ejecutaría.)

## 16. No medido

- Lector de pantalla real (NVDA/JAWS) y Lighthouse. axe sí corre en el E2E y en las verificaciones
  en vivo.
- El contraste se calcula sobre los valores de los tokens, no sobre capturas.
- Proveedores reales: correo SMTP, ubicación con el archivo de DB-IP, almacenamiento S3, IA
  (Anthropic + Voyage) y voz (Deepgram). Todo lo anterior se probó con los modos simulados.
- La verificación en dos pasos se probó con códigos calculados (RFC 6238) en los tests y el E2E.
  El código acepta ±1 paso de 30 s de desfase de reloj; un desfase mayor no se midió con teléfonos
  reales.
- La forma de onda y el barrido de color con micrófonos y equipos distintos al de las pruebas.
