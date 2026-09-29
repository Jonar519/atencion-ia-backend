import { Request, Response } from "express";
import { kbService } from "./kb.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";
import type { ListArticlesQuery } from "./kb.schema";

export const kbController = {
  async list(req: Request, res: Response) {
    res.json(await kbService.list(req.query as unknown as ListArticlesQuery));
  },

  async get(req: Request, res: Response) {
    res.json(await kbService.get(routeParam(req, "id")));
  },

  async create(req: Request, res: Response) {
    const article = await kbService.create(currentUser(req).staffId, req.body);
    audit(req, {
      action: "kb.create",
      entityType: "kb_article",
      entityId: article.id,
      metadata: { status: article.status },
    });
    res.status(201).json(article);
  },

  async update(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const { article, contentChanged } = await kbService.update(currentUser(req).staffId, id, req.body);
    audit(req, {
      action: "kb.update",
      entityType: "kb_article",
      entityId: id,
      metadata: { fields: Object.keys(req.body), version: article.version, contentChanged },
    });
    res.json(article);
  },

  async remove(req: Request, res: Response) {
    const id = routeParam(req, "id");
    await kbService.remove(id);
    audit(req, { action: "kb.delete", entityType: "kb_article", entityId: id });
    res.status(204).end();
  },
};
