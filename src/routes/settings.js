import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { updateSettingsSchema } from "../schemas/settings.js";

const router = Router();
const log = logger.child({ module: "routes/settings" });

router.get("/", async (_req, res) => {
  try {
    const settings = await prisma.clinicSettings.findUnique({ where: { id: 1 } });
    res.json(
      settings ?? {
        name: "",
        tagline: "",
        phone: "",
        emergency: "",
        whatsapp: "",
        email: "",
        address: "",
        currency: "EGP",
        instapay: "",
        googlePlacesKey: "",
        googlePlacesId: "",
      }
    );
  } catch (e) {
    log.error({ err: e }, "failed to fetch settings");
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.patch("/", authenticateUser, requireAdmin, validate(updateSettingsSchema), async (req, res) => {
  const patch = req.validated.body;
  try {
    const updated = await prisma.clinicSettings.upsert({
      where: { id: 1 },
      update: {
        name: patch.name,
        tagline: patch.tagline,
        phone: patch.phone,
        emergency: patch.emergency,
        whatsapp: patch.whatsapp,
        email: patch.email,
        address: patch.address,
        currency: patch.currency,
        instapay: patch.instapay,
        googlePlacesKey: patch.googlePlacesKey,
        googlePlacesId: patch.googlePlacesId,
      },
      create: {
        id: 1,
        name: patch.name ?? "Paw-M",
        tagline: patch.tagline ?? "",
        phone: patch.phone ?? "",
        emergency: patch.emergency ?? "",
        whatsapp: patch.whatsapp ?? "",
        email: patch.email ?? "",
        address: patch.address ?? "",
        currency: patch.currency ?? "EGP",
        instapay: patch.instapay ?? "",
        googlePlacesKey: patch.googlePlacesKey ?? "",
        googlePlacesId: patch.googlePlacesId ?? "",
      },
    });
    logAudit("settings_update", "", "Clinic settings updated");
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to update settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
