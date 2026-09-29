import { Request, Response } from "express";
import { callsService } from "./calls.service";
import { consentNotice } from "./consent";
import { currentWidget } from "../widget/widgetAuth.middleware";
import { currentUser, routeParam } from "../../utils/params";

export const voiceController = {
  // --- Cliente (widget) ---
  consent(_req: Request, res: Response) {
    res.json(consentNotice());
  },

  async start(req: Request, res: Response) {
    res.status(201).json(await callsService.start(currentWidget(req), routeParam(req, "id"), req.body, req));
  },

  async getForCustomer(req: Request, res: Response) {
    res.json(await callsService.getForCustomer(currentWidget(req), routeParam(req, "id")));
  },

  async endByCustomer(req: Request, res: Response) {
    await callsService.endByCustomer(currentWidget(req), routeParam(req, "id"));
    res.status(204).end();
  },

  // --- Staff (panel) ---
  async active(req: Request, res: Response) {
    res.json({ items: await callsService.active(currentUser(req)) });
  },

  async transcript(req: Request, res: Response) {
    res.json(await callsService.transcript(currentUser(req), routeParam(req, "id")));
  },

  async join(req: Request, res: Response) {
    res.json(await callsService.join(currentUser(req), routeParam(req, "id"), req));
  },

  async leave(req: Request, res: Response) {
    await callsService.leave(currentUser(req), routeParam(req, "id"), req);
    res.status(204).end();
  },

  async endByStaff(req: Request, res: Response) {
    await callsService.endByStaff(currentUser(req), routeParam(req, "id"), req);
    res.status(204).end();
  },
};
