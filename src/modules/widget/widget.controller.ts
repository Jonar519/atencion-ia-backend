import { Request, Response } from "express";
import { widgetService } from "./widget.service";
import { currentWidget } from "./widgetAuth.middleware";
import { routeParam } from "../../utils/params";

export const widgetController = {
  async createSession(req: Request, res: Response) {
    res.status(201).json(await widgetService.createSession(req.body, { ip: req.ip, userAgent: req.get("user-agent") }));
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
