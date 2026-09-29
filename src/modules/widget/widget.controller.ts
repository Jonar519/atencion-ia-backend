import { Request, Response } from "express";
import { widgetService } from "./widget.service";
import { currentWidget, WIDGET_COOKIE, widgetCookieOptions } from "./widgetAuth.middleware";
import { routeParam } from "../../utils/params";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../../middlewares/csrf.middleware";

export const widgetController = {
  /**
   * Crea la sesión anónima. Siempre deja el token en una cookie httpOnly.
   * Al navegador (que se identifica con el encabezado anti-CSRF) NO se le
   * devuelve el token en el cuerpo: así el JavaScript de la página nunca lo
   * tiene. Un cliente de API (curl) sí lo recibe, para usarlo como Bearer.
   */
  async createSession(req: Request, res: Response) {
    const session = await widgetService.createSession(req.body, { ip: req.ip, userAgent: req.get("user-agent") });
    res.cookie(WIDGET_COOKIE, session.token, widgetCookieOptions());
    const fromBrowser = req.get(CSRF_HEADER) === CSRF_HEADER_VALUE;
    res.status(201).json({
      customerId: session.customerId,
      expiresAt: session.expiresAt,
      ...(fromBrowser ? {} : { token: session.token }),
    });
  },

  /** ¿Hay una sesión vigente? El widget lo pregunta al cargar para retomar la conversación. */
  async currentSession(req: Request, res: Response) {
    const identity = currentWidget(req);
    res.json(await widgetService.sessionInfo(identity));
  },

  /** Terminar la sesión: se revoca en la base y se borra la cookie. */
  async endSession(req: Request, res: Response) {
    await widgetService.endSession(currentWidget(req));
    const { maxAge: _maxAge, ...options } = widgetCookieOptions();
    res.clearCookie(WIDGET_COOKIE, options);
    res.status(204).end();
  },

  async createConversation(req: Request, res: Response) {
    res.status(201).json(await widgetService.createConversation(currentWidget(req), req.body));
  },

  async listConversations(req: Request, res: Response) {
    res.json({ items: await widgetService.listConversations(currentWidget(req)) });
  },

  async messages(req: Request, res: Response) {
    const query = req.query as unknown as { limit: number; cursor?: string };
    res.json(await widgetService.messages(currentWidget(req), routeParam(req, "id"), query));
  },

  async sendMessage(req: Request, res: Response) {
    const result = await widgetService.sendMessage(currentWidget(req), routeParam(req, "id"), req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  },
};
