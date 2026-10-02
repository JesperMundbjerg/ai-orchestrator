import type { Helper } from "./types.ts";

/** Definition names, including .claude/agents/*review*.md, are reported as Helper.type. */
export const isReviewHelper = (helper: Pick<Helper, "type">): boolean => /review/i.test(helper.type);
