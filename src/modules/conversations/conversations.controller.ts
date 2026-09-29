import { Request, Response } from "express";
import { conversationsService } from "./conversations.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";
import { conversationEvents } from "../../observability/metrics";
import type { ListConversationsQuery, MessagesQuery } from "./conversations.schema";

export const conversationsController = {
  async list(req: Request, res: Response) {
    res.json(await conversationsService.list(currentUser(req), req.query as unknown as ListConversationsQuery));
  },

  async get(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const conversation = await conversationsService.get(currentUser(req), id);
    // Ver una conversación = acceder a datos personales de un cliente.
    audit(req, { action: "conversation.view", entityType: "conversation", entityId: id });
    res.json(conversation);
  },

  async messages(req: Request, res: Response) {
    const query = req.query as unknown as MessagesQuery;
    res.json(await conversationsService.messages(currentUser(req), routeParam(req, "id"), query));
  },

  async take(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const conversation = await conversationsService.take(currentUser(req), id);
    conversationEvents.inc({ event: "take" });
    audit(req, { action: "conversation.take", entityType: "conversation", entityId: id });
    res.json(conversation);
  },

  async close(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const conversation = await conversationsService.close(currentUser(req), id, req.body);
    conversationEvents.inc({ event: "close" });
    audit(req, {
      action: "conversation.close",
      entityType: "conversation",
      entityId: id,
      metadata: { reason: req.body.reason },
    });
    res.json(conversation);
  },

  async sendMessage(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const { message, created } = await conversationsService.sendAgentMessage(currentUser(req), id, req.body);
    // Sin el contenido del mensaje: solo que existió.
    if (created) audit(req, { action: "conversation.message", entityType: "conversation", entityId: id });
    res.status(created ? 201 : 200).json(message);
  },
};
