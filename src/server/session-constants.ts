// Split out from session.ts so middleware.ts (which runs on the Edge runtime
// and must not pull in Prisma/Node crypto) can share the cookie name without
// importing anything Node-specific.
export const SESSION_COOKIE_NAME = "nutriclinic_session";
