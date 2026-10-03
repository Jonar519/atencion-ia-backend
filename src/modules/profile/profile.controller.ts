import { Request, Response } from "express";
import { EMAIL_CHANGE_REQUESTED, profileService } from "./profile.service";
import { mfaService } from "../auth/mfa.service";
import { sessionsService } from "../auth/sessions.service";
import { audit } from "../../services/audit/audit.service";
import { currentUser, routeParam } from "../../utils/params";

const self = (req: Request) => {
  const user = currentUser(req);
  return { staffId: user.staffId, sessionId: user.sessionId };
};

const auditSelf = (
  req: Request,
  action: Parameters<typeof audit>[1]["action"],
  metadata?: Record<string, string | number>
) => {
  const { staffId } = self(req);
  audit(req, { action, entityType: "staff_user", entityId: staffId, ...(metadata ? { metadata } : {}) });
};

export const profileController = {
  async get(req: Request, res: Response) {
    res.json(await profileService.get(self(req).staffId));
  },

  async update(req: Request, res: Response) {
    const profile = await profileService.update(self(req).staffId, req.body);
    // Qué campos cambiaron (nombres, no valores).
    auditSelf(req, "profile.update", { fields: Object.keys(req.body).join(",") });
    res.json(profile);
  },

  async requestEmailChange(req: Request, res: Response) {
    await profileService.requestEmailChange(self(req).staffId, req.body);
    auditSelf(req, "profile.email_change_requested");
    res.status(202).json({ message: EMAIL_CHANGE_REQUESTED });
  },

  async changePassword(req: Request, res: Response) {
    const { staffId, sessionId } = self(req);
    const result = await profileService.changePassword(staffId, sessionId, req.body);
    auditSelf(req, "profile.password_changed", { otherSessionsClosed: result.otherSessionsClosed });
    res.json(result);
  },

  async setAvatar(req: Request, res: Response) {
    const profile = await profileService.setAvatar(self(req).staffId, req.body);
    auditSelf(req, "profile.avatar_updated");
    res.json(profile);
  },

  async deleteAvatar(req: Request, res: Response) {
    const profile = await profileService.deleteAvatar(self(req).staffId);
    auditSelf(req, "profile.avatar_deleted");
    res.json(profile);
  },

  async getAvatar(req: Request, res: Response) {
    const file = await profileService.getAvatar(routeParam(req, "id"));
    res.set("Content-Type", file.contentType);
    // Nunca se interpreta como documento aunque alguien lograra subir otra cosa.
    res.set("Content-Disposition", "inline");
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(file.data);
  },

  async sessions(req: Request, res: Response) {
    const { staffId, sessionId } = self(req);
    res.json({ items: await sessionsService.listActive(staffId, sessionId) });
  },

  async revokeSession(req: Request, res: Response) {
    const id = routeParam(req, "id");
    await sessionsService.revokeOwn(self(req).staffId, id);
    audit(req, { action: "session.revoke", entityType: "session", entityId: id });
    res.status(204).end();
  },

  async revokeOtherSessions(req: Request, res: Response) {
    const { staffId, sessionId } = self(req);
    const closed = await sessionsService.revokeOthers(staffId, sessionId);
    auditSelf(req, "session.revoke_others", { closed });
    res.json({ closed });
  },

  async exportData(req: Request, res: Response) {
    const data = await profileService.export(self(req).staffId);
    auditSelf(req, "profile.export");
    res.set("Content-Disposition", 'attachment; filename="mis-datos-atencion-ia.json"');
    res.json(data);
  },

  // --- Verificación en dos pasos desde el perfil (agentes: opcional; admin ya la tiene) ---

  async mfaSetup(req: Request, res: Response) {
    res.json(await mfaService.beginEnrollment(self(req).staffId));
  },

  async mfaConfirm(req: Request, res: Response) {
    const backupCodes = await mfaService.confirmEnrollment(self(req).staffId, req.body.code);
    auditSelf(req, "mfa.enabled");
    res.json({ backupCodes });
  },

  async mfaDisable(req: Request, res: Response) {
    await mfaService.disable(self(req).staffId, req.body.password, req.body.code);
    auditSelf(req, "mfa.disabled");
    res.status(204).end();
  },

  async mfaBackupCodes(req: Request, res: Response) {
    const backupCodes = await mfaService.regenerateBackupCodes(self(req).staffId, req.body.code);
    auditSelf(req, "mfa.backup_codes_regenerated");
    res.json({ backupCodes });
  },
};
