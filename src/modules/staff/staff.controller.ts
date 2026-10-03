import { Request, Response } from "express";
import { staffService } from "./staff.service";
import { invitationsService } from "./invitations.service";
import { profileService } from "../profile/profile.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";

export const staffController = {
  async list(_req: Request, res: Response) {
    res.json({ items: await staffService.list() });
  },

  /** Invitar (bloque F2). La respuesta NO incluye el enlace: solo viaja por correo. */
  async invite(req: Request, res: Response) {
    const invited = await invitationsService.invite(currentUser(req).staffId, req.body);
    audit(req, {
      action: "staff.invite",
      entityType: "staff_user",
      entityId: invited.id,
      metadata: { role: invited.role },
    });
    res.status(201).json(await staffService.getListed(invited.id));
  },

  async resendInvitation(req: Request, res: Response) {
    const id = routeParam(req, "id");
    await invitationsService.resend(id);
    audit(req, { action: "staff.invitation_resent", entityType: "staff_user", entityId: id });
    res.json(await staffService.getListed(id));
  },

  async cancelInvitation(req: Request, res: Response) {
    const id = routeParam(req, "id");
    await invitationsService.cancel(id);
    audit(req, { action: "staff.invitation_cancelled", entityType: "staff_user", entityId: id });
    res.status(204).end();
  },

  async update(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const staff = await staffService.update(currentUser(req).staffId, id, req.body);
    // Qué campos cambiaron (nombres, no valores).
    audit(req, {
      action: "staff.update",
      entityType: "staff_user",
      entityId: id,
      metadata: { fields: Object.keys(req.body) },
    });
    res.json(staff);
  },

  async setMyAvailability(req: Request, res: Response) {
    const { staffId } = currentUser(req);
    const staff = await staffService.setAvailability(staffId, req.body.availability);
    audit(req, {
      action: "staff.availability",
      entityType: "staff_user",
      entityId: staffId,
      metadata: { availability: staff.availability },
    });
    res.json(staff);
  },

  /** Exportar los datos de un agente (admin), p. ej. antes de eliminar su cuenta. */
  async exportData(req: Request, res: Response) {
    const id = routeParam(req, "id");
    await staffService.getPublic(id);
    const data = await profileService.export(id);
    audit(req, { action: "profile.export", entityType: "staff_user", entityId: id, metadata: { by: "admin" } });
    res.set("Content-Disposition", `attachment; filename="agente-${id.slice(0, 8)}.json"`);
    res.json(data);
  },

  async anonymize(req: Request, res: Response) {
    const id = routeParam(req, "id");
    const staff = await staffService.anonymize(currentUser(req).staffId, id);
    audit(req, { action: "staff.anonymize", entityType: "staff_user", entityId: id });
    res.json(staff);
  },
};
