import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { contactSchema } from "../schemas/contact.js";
import { sendMail, buildContactEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";

const router = Router();
const log = logger.child({ module: "routes/contact" });

// POST /api/contact — submit contact form
router.post("/", validate(contactSchema), async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.validated.body;

    const clinicSettings = await (async () => {
      const { prisma } = await import("../lib/prisma.js");
      return prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    })();

    const clinicName = clinicSettings?.name || "Paw-M Clinic";

    await sendMail(buildContactEmail({
      to: clinicSettings?.email || "hello@pawclinicmadinaty.com",
      name,
      email,
      phone,
      subject,
      message,
      clinicName,
    }));

    log.info({ email, subject }, "contact form submitted");
    res.json({ message: "Message sent successfully" });
  } catch (error) {
    log.error({ err: error }, "failed to send contact email");
    res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;