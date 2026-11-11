import { z } from 'zod';

/** The design and the implementation plan the planner writes, both markdown. */
export const designDocsSchema = z.object({ design: z.string().min(1), plan: z.string().min(1) });

export type DesignDocs = z.infer<typeof designDocsSchema>;
