import { z } from "zod";

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional().default(""),
    price: z.number().nonnegative(),
    compareAtPrice: z.number().nonnegative().nullable().optional(),
    image: z.string().max(5_000_000).optional().default(""),
    category: z.string().max(60).optional().default("accessories"),
    petType: z.enum(["dog", "cat", "both"]).optional().default("both"),
    stock: z.number().int().nonnegative(),
    featured: z.boolean().optional().default(false),
    barcode: z.string().trim().max(128).nullable().optional(),
    barcodeImage: z.string().max(5_000_000).nullable().optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    name: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    price: z.number().nonnegative().optional(),
    compareAtPrice: z.number().nonnegative().nullable().optional(),
    image: z.string().max(5_000_000).optional(),
    category: z.string().max(60).optional(),
    petType: z.enum(["dog", "cat", "both"]).optional(),
    stock: z.number().int().nonnegative().optional(),
    featured: z.boolean().optional(),
    barcode: z.string().trim().max(128).nullable().optional(),
    barcodeImage: z.string().max(5_000_000).nullable().optional(),
  }),
});

export const updateStockSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    qtyChange: z.number().int().refine((n) => n !== 0, "qtyChange must not be zero"),
    note: z.string().max(500).optional().default(""),
    type: z.enum(["restock", "adjustment", "damage", "return"]).optional(),
  }),
});
