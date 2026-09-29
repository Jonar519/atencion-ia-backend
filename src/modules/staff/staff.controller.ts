import { Request, Response } from "express";
import { staffService } from "./staff.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";

export const staffController = {
  async list(_req: Request, res: Response) {
    res.json({ items: await staffService.list() });
  },

  async create(req: Request, res: Response) {
    const staff = await staffService.create(req.body);
    audit(req, {
      action: "staff.create",
      entityType: "staff_user",
      entityId: staff.id,
      metadata: { role: staff.role },
    });
    res.status(201).json(staff);
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
};
