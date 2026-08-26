import { z } from "zod";

export const updateSettingsSchema = z.object({
  body: z.object({
    name: z.string().max(120).optional(),
    tagline: z.string().max(300).optional(),
    phone: z.string().max(40).optional(),
    emergency: z.string().max(40).optional(),
    whatsapp: z.string().max(40).optional(),
    email: z.string().max(120).optional(),
    address: z.string().max(500).optional(),
    currency: z.string().min(1).max(8).optional(),
    instapay: z.string().max(80).optional(),
    googlePlacesKey: z.string().max(200).optional(),
    googlePlacesId: z.string().max(200).optional(),
  }),
});
