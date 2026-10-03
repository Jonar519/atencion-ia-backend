import { Request, Response } from "express";
import { conversationsService } from "./conversations.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";
import { conversationEvents } from "../../observability/metrics";
import type { ListConversationsQuery, MessagesQuery } from "./conversations.schema";
import { readAttachmentMeta, sendAttachment } from "../attachments/attachments.http";
import { attachmentForStaff, discardAttachment, storeAttachment } from "../attachments/attachments.service";
import { ATTACHMENT_PLACEHOLDER } from "../attachments/fileChecks";

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

  async reassign(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const conversation = await conversationsService.reassign(id, req.body.agentId);
    audit(req, {
      action: "conversation.reassign",
      entityType: "conversation",
      entityId: id,
      metadata: { from: conversation.fromAgentId, to: req.body.agentId },
    });
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

  /** Adjunto del asesor: mismas reglas que responder (solo quien atiende el caso). */
  async sendAttachment(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const user = currentUser(req);
    const meta = readAttachmentMeta(req);
    const stored = await storeAttachment({ conversationId: id, data: req.body, declaredName: meta.fileName });
    let result: Awaited<ReturnType<typeof conversationsService.sendAgentMessage>>;
    try {
      result = await conversationsService.sendAgentMessage(
        user,
        id,
        { content: meta.caption ?? ATTACHMENT_PLACEHOLDER, clientMsgId: meta.clientMsgId },
        stored
      );
    } catch (err) {
      await discardAttachment(stored);
      throw err;
    }
    if (!result.created) await discardAttachment(stored);
    else
      audit(req, {
        action: "conversation.message",
        entityType: "conversation",
        entityId: id,
        metadata: { attachment: true },
      });
    res.status(result.created ? 201 : 200).json(result.message);
  },

  /** Ver/descargar un adjunto: solo si puede ver la conversación (si no, 404). */
  async attachment(req: Request, res: Response) {
    const found = await attachmentForStaff(currentUser(req), routeParam(req, "id"), routeParam(req, "attachmentId"));
    sendAttachment(res, found);
  },
};
