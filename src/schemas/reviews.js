import { z } from "zod";

export const createReviewSchema = z.object({
  body: z.object({
    productId: z.string().min(1, "productId is required"),
    author: z.string().min(1, "author is required").max(80),
    rating: z.number().int().min(1, "Rating must be between 1 and 5").max(5),
    comment: z.string().min(4, "Comment must be at least 4 characters"),
  }),
});

export const updateReviewStatusSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["approved", "rejected"]),
  }),
});
